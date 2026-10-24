// Behavioural tests for the service worker. They run the REAL built source
// (buildServiceWorkerSource) in a node:vm context with an in-memory
// CacheStorage and a mocked fetch, so what ships to browsers is what is tested.

import { describe, it, expect, vi } from "vitest";

import {
  CACHE_NAMES,
  HEADER_CACHED_AT,
  HEADER_TITLE,
  SYNC_MAX_IDS,
  clusterPath,
} from "@/lib/pwa/sw-contract";
import * as policy from "@/lib/pwa/sw-policy";
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source";

import {
  fakeRequest,
  fakeResponse,
  loadWorker,
  sleep,
  trackConcurrency,
  type FetchImpl,
  type LoadedWorker,
} from "../_helpers/sw-harness";

const ORIGIN = "https://tayf.test";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "11111111-2222-3333-4444-555555555555";
const ID3 = "22222222-3333-4444-5555-666666666666";
const ID4 = "33333333-4444-5555-6666-777777777777";
const ID5 = "44444444-5555-6666-7777-888888888888";
const ID6 = "55555555-6666-7777-8888-999999999999";
const ID7 = "55555555-6666-7777-8888-000000000000";
const ID8 = "66666666-7777-8888-9999-000000000000";
const OVERRIDES = { navTimeoutMs: 30, pagesMaxEntries: 2, staticMaxEntries: 3, savedMaxEntries: 2 };
const SOURCE = buildServiceWorkerSource({ config: OVERRIDES });
const CSP = "default-src 'self'; connect-src 'self' https:";
const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

const urlOf = (id: string) => `${ORIGIN}/cluster/${id}`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
// A real story carries og:type=article (the cluster page's generateMetadata). The two shells below are what the
// same route answers WITH HTTP 200 on a read failure (./error.tsx) and for a missing/merged cluster
// (notFound()): PPR has already flushed the status, and they inherit og:type=website.
const page = (title = "Test haber", extra = "") =>
  `<!doctype html><html><head><title>${title} — Tayf</title><meta property="og:title" content="${title}"/><meta property="og:type" content="article"/></head><body>${extra}</body></html>`;
const NOT_FOUND_SHELL =
  '<!doctype html><html><head><title>Sayfa bulunamadı — Tayf</title><meta property="og:title" content="Sayfa bulunamadı — Tayf"/><meta property="og:type" content="website"/></head><body>Sayfa bulunamadı</body></html>';
const ERROR_SHELL =
  '<!doctype html><html><head><title>Haber şu anda yüklenemiyor — Tayf</title><meta property="og:title" content="Tayf — Türkiye Haber Analizi"/><meta property="og:type" content="website"/></head><body>Haber şu anda yüklenemiyor</body></html>';
const SHELLS: Array<[string, string]> = [
  ["not-found shell", NOT_FOUND_SHELL],
  ["error shell", ERROR_SHELL],
];

function pageRes(id: string, body = page(), over: { status?: number; headers?: Record<string, string>; redirected?: boolean; type?: ResponseType } = {}) {
  return fakeResponse(body, {
    url: urlOf(id),
    status: over.status,
    redirected: over.redirected,
    type: over.type,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "cache-control": NO_STORE,
      vary: "RSC, Next-Router-State-Tree",
      ...over.headers,
    },
  });
}

function stored(body: string, headers: Record<string, string> = {}) {
  return fakeResponse(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

const OFFLINE_HTML = [
  "<!doctype html><title>Çevrimdışı — Tayf</title>",
  '<link rel="stylesheet" href="/_next/static/css/a.css?dpl=dpl_9"/>',
  '<script src="/_next/static/chunks/b.js" async></script>',
  '<script src="https://cdn.test/_next/static/chunks/evil.js"></script>',
].join("");
const ASSET_A = `${ORIGIN}/_next/static/css/a.css?dpl=dpl_9`;
const ASSET_B = `${ORIGIN}/_next/static/chunks/b.js`;

function urlString(input: string | Request): string {
  return typeof input === "string" ? input : input.url;
}

/** fetch router: offline shell + its assets answer, everything else delegates to `rest`. */
function shellAwareFetch(rest?: FetchImpl): FetchImpl {
  return async (input, init) => {
    const url = urlString(input);
    if (url === `${ORIGIN}/offline`) {
      return fakeResponse(OFFLINE_HTML, {
        url,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": CSP,
          "cache-control": NO_STORE,
        },
      });
    }
    if (url.startsWith(`${ORIGIN}/_next/static/`)) {
      return fakeResponse("asset:" + url, {
        url,
        headers: { "content-type": "text/css", "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    if (rest) return rest(input, init);
    throw new TypeError("unexpected fetch " + url);
  };
}

function load(fetch?: FetchImpl, config: Record<string, number> = {}): LoadedWorker {
  const source = Object.keys(config).length
    ? buildServiceWorkerSource({ config: { ...OVERRIDES, ...config } })
    : SOURCE;
  return loadWorker({ source, fetch });
}

async function seedShell(w: LoadedWorker, cachedAt = iso(0)) {
  await w.caches.seed(
    CACHE_NAMES.shell,
    `${ORIGIN}/offline`,
    stored("<html>OFFLINE SHELL</html>", { [HEADER_CACHED_AT]: cachedAt }),
  );
}

async function bodyOf(res: Response | null | undefined): Promise<string> {
  expect(res).toBeTruthy();
  return (res as Response).text();
}

// ---------------------------------------------------------------------------
// Parity: the runtime string re-declares each pure helper of sw-policy.ts
// ---------------------------------------------------------------------------

describe("runtime parity with sw-policy.ts", () => {
  const w = load();
  const call = (name: string, ...args: unknown[]) => {
    const fn = w.ctx[name];
    expect(typeof fn, `${name} must be a top-level function of the worker`).toBe("function");
    return JSON.parse(JSON.stringify((fn as (...a: unknown[]) => unknown)(...args)));
  };
  const twin = (fn: (...a: never[]) => unknown, ...args: unknown[]) =>
    JSON.parse(JSON.stringify((fn as (...a: unknown[]) => unknown)(...args)));

  const headers = (init: Record<string, string> = {}) => ({
    get: (n: string) => init[n.toLowerCase()] ?? null,
  });

  it("isBypassedPath", () => {
    for (const p of [
      "/", "/api", "/api/x", "/API/x", "/apix", "/embed", "/embed/cluster/" + ID, "/embedded",
      "/_vercel", "/_vercel/insights/script.js", "/admin", "/admin/login", "/adminx", "/ADMIN",
      "/sw.js", "/SW.JS", "/sw.json", "/_next", "/_next/image", "/_next/data/x.json",
      "/_next/static/chunks/a.js", "/cluster/" + ID, "/offline", "",
    ]) {
      expect(call("isBypassedPath", p), p).toBe(twin(policy.isBypassedPath, p));
    }
  });

  it("classifyRequest", () => {
    const base = { method: "GET", url: `${ORIGIN}/`, mode: "navigate" };
    const cases: Array<Record<string, unknown>> = [
      base,
      { ...base, method: "POST" },
      { ...base, url: "https://evil.test/" },
      { ...base, url: `${ORIGIN}/API/x` },
      { ...base, url: `${ORIGIN}/admin` },
      { ...base, url: `${ORIGIN}/adminx` },
      { ...base, url: `${ORIGIN}/embed/cluster/${ID}` },
      { ...base, url: `${ORIGIN}/_vercel/insights/script.js`, mode: "no-cors" },
      { ...base, url: `${ORIGIN}/_next/image?url=%2Fa.png`, mode: "no-cors" },
      { ...base, url: `${ORIGIN}/sw.js`, mode: "same-origin" },
      { ...base, url: `${ORIGIN}/_next/static/chunks/a.js?dpl=x`, mode: "no-cors" },
      { ...base, url: `${ORIGIN}/_next/static/chunks/a.js`, hasRange: true, mode: "no-cors" },
      { ...base, url: `${ORIGIN}/_next/static/chunks/a.js`, cache: "only-if-cached", mode: "cors" },
      { ...base, url: `${ORIGIN}/_next/static/chunks/a.js`, cache: "only-if-cached", mode: "same-origin" },
      { ...base, url: `${ORIGIN}/cluster/${ID}?_rsc=1`, mode: "cors" },
      { ...base, url: `${ORIGIN}/cluster/${ID}?utm_source=x` },
      { ...base, url: "garbage" },
    ];
    for (const c of cases) {
      expect(call("classifyRequest", c, ORIGIN), JSON.stringify(c)).toBe(twin(policy.classifyRequest, c, ORIGIN));
    }
  });

  it("pageCacheKey", () => {
    for (const u of [
      urlOf(ID), urlOf(ID.toUpperCase()), `${urlOf(ID)}?utm=1#x`, `${urlOf(ID)}/`, `${urlOf(ID)}/kart`,
      `${ORIGIN}/`, `${ORIGIN}/cluster/nope`, `https://evil.test/cluster/${ID}`, "garbage", "",
    ]) {
      expect(call("pageCacheKey", u, ORIGIN), u).toBe(twin(policy.pageCacheKey, u, ORIGIN));
    }
  });

  it("isCacheableResponse", () => {
    const targets = ["static", "page", "shell"] as const;
    const urls = [
      urlOf(ID), `${urlOf(ID)}?utm=1`, `${ORIGIN}/offline`, `${ORIGIN}/_next/static/a.js?dpl=1`,
      `${ORIGIN}/`, `https://evil.test/cluster/${ID}`, "", "garbage",
    ];
    const headerSets: Array<Record<string, string>> = [
      { "content-type": "text/html" },
      { "content-type": "text/html", "cache-control": NO_STORE },
      { "content-type": "application/javascript", "cache-control": "public, max-age=1" },
      { "content-type": "application/json" },
      { "content-type": "text/html", "set-cookie": "a=b" },
      {},
    ];
    for (const target of targets) {
      for (const url of urls) {
        for (const hs of headerSets) {
          for (const over of [{}, { status: 404 }, { type: "opaque" }, { type: "cors" }, { redirected: true }]) {
            const res = { status: 200, type: "basic", redirected: false, url, headers: headers(hs), ...over };
            expect(call("isCacheableResponse", res, ORIGIN, target), JSON.stringify([target, url, hs, over])).toBe(
              twin(policy.isCacheableResponse, res, ORIGIN, target),
            );
          }
        }
      }
    }
  });

  it("planTrim, isExpired, cachesToDelete", () => {
    for (const [keys, max] of [[["a", "b", "c", "d"], 2], [["a"], 3], [[], 1], [["a", "b"], 0], [["a", "b"], -1], [["a", "b"], Number.NaN]] as const) {
      expect(call("planTrim", keys, max)).toEqual(twin(policy.planTrim, keys, max));
    }
    const now = Date.parse("2026-10-23T12:00:00Z");
    for (const stamp of [null, "", "x", new Date(now).toISOString(), new Date(now - 14 * DAY).toISOString(), new Date(now - 14 * DAY - 1).toISOString(), new Date(now + 5000).toISOString()]) {
      expect(call("isExpired", stamp, now, 14 * DAY), String(stamp)).toBe(twin(policy.isExpired, stamp, now, 14 * DAY));
    }
    const existing = ["tayf-static-v0", "tayf-pages-v1", "tayf-saved-v1", "other-lib", "tayf", "tayf-x"];
    for (const keep of [[], Object.values(CACHE_NAMES), ["tayf-x"]]) {
      expect(call("cachesToDelete", existing, keep)).toEqual(twin(policy.cachesToDelete, existing, keep));
    }
  });

  it("extractTitle", () => {
    for (const html of [
      "",
      "<title>Plain</title>",
      "<title>İlk</title>...<title>Son — Tayf</title>",
      '<title>X</title><meta property="og:title" content="Og &amp; &quot;q&quot; &#350;"/>',
      "<meta content='ters' property='og:title'>",
      '<meta property="og:title" content=""><title>Yedek — Tayf</title>',
      "<title>&#99999999999; &#xD800; &#0; &amp;lt;</title>",
      "<title>" + "a".repeat(500) + "</title>",
      "<title>" + "a".repeat(199) + "\u{1F600}tail</title>",
      "<title>   </title>",
      "<title> — Tayf</title>",
      "<title>Tayf — Haber Analizi</title>",
      '<meta name="twitter:title" content="x"><title>T</title>',
    ]) {
      expect(call("extractTitle", html), html.slice(0, 40)).toBe(twin(policy.extractTitle, html));
    }
  });

  it("isStoryHtml", () => {
    for (const html of [
      "",
      page(),
      NOT_FOUND_SHELL,
      ERROR_SHELL,
      '<meta content="article" property="og:type">',
      "<meta content='ARTICLE' property='og:type'/>",
      '<meta property="og:type" content=" article "/>',
      '<meta property="og:type" content="articles"/>',
      '<meta property="og:type" content=""/>',
      '<meta property="og:title" content="article"/>',
      '<meta property="article:author" content="article"/>',
      '<p>&lt;meta property="og:type" content="article"&gt;</p>',
      '<meta property="og:type" content="website"/><meta property="og:type" content="article"/>',
    ]) {
      expect(call("isStoryHtml", html), html.slice(0, 60)).toBe(twin(policy.isStoryHtml, html));
    }
  });

  it("extractShellAssets", () => {
    const html = OFFLINE_HTML +
      '<script src="/_next/static/chunks/b.js"></script><link href="/_next/static/x.css?a=1&amp;b=2"/>' +
      '<script src="/_next/static/../../admin/x.js"></script><img src="/_next/static/frag.png#x"/>';
    for (const [h, max] of [[html, 60], [html, 1], [html, 0], ["", 5], ["<p/>", 5]] as const) {
      expect(call("extractShellAssets", h, ORIGIN, max)).toEqual(twin(policy.extractShellAssets, h, ORIGIN, max));
    }
  });

  it("parseMessage and clusterPath", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    for (const [data, max] of [
      [{ type: "tayf:pin", id: ID }, 500],
      [{ type: "tayf:unpin", id: ID.toUpperCase() }, 500],
      [{ type: "tayf:pin", id: "../admin" }, 500],
      [{ type: "tayf:sync", ids: [ID, ID.toUpperCase(), "bad", 4, ID2] }, 500],
      [{ type: "tayf:sync", ids }, 3],
      [{ type: "tayf:sync", ids }, 0],
      [{ type: "tayf:sync", ids: "x" }, 500],
      [null, 500], [undefined, 500], ["s", 500], [[], 500], [{}, 500], [{ type: "nope" }, 500],
    ] as const) {
      expect(call("parseMessage", data, max), JSON.stringify(data)).toEqual(twin(policy.parseMessage, data, max));
    }
    for (const id of [ID, ID.toUpperCase(), "../admin", "", `${ID}/x`]) {
      expect(call("clusterPath", id), id).toBe(twin(clusterPath, id));
    }
  });

  it("buildStoredHeaders", () => {
    const src = headers({
      "content-type": "text/html",
      "content-security-policy": CSP,
      "x-frame-options": "DENY",
      vary: "RSC",
      "content-encoding": "br",
      "set-cookie": "a=b",
    });
    for (const title of [undefined, "", "Şehir & haber", "bad\ud800"]) {
      expect(call("buildStoredHeaders", src, "2026-10-23T00:00:00.000Z", title)).toEqual(
        twin(policy.buildStoredHeaders, src, "2026-10-23T00:00:00.000Z", title),
      );
    }
  });

  it("embeds the merged config and the shared contract constants", () => {
    expect(w.evaluate("JSON.parse(JSON.stringify(CONFIG))")).toEqual({ ...policy.SW_CONFIG, ...OVERRIDES });
    expect(w.evaluate("CONTRACT.headerCachedAt")).toBe(HEADER_CACHED_AT);
    expect(w.evaluate("CONTRACT.headerTitle")).toBe(HEADER_TITLE);
    expect(w.evaluate("JSON.parse(JSON.stringify(CONTRACT.copiedHeaders))")).toEqual([...policy.COPIED_PAGE_HEADERS]);
    expect(w.evaluate("CONTRACT.fallbackTitle")).toBe(policy.FALLBACK_TITLE);
    expect(w.evaluate("CONFIG.syncMaxIds")).toBe(SYNC_MAX_IDS);
  });

  it("registers exactly install, activate, fetch and message listeners", () => {
    expect(w.listenerTypes().sort()).toEqual(["activate", "fetch", "install", "message"]);
  });
});

// ---------------------------------------------------------------------------
// Bypass: the worker stays out of the way
// ---------------------------------------------------------------------------

describe("bypassed requests", () => {
  const cases: Array<[string, () => Request]> = [
    ["/api/x", () => fakeRequest(`${ORIGIN}/api/x`, { mode: "cors" })],
    ["/API/x (case)", () => fakeRequest(`${ORIGIN}/API/x`, { mode: "cors" })],
    ["/admin navigation", () => fakeRequest(`${ORIGIN}/admin`)],
    ["/admin/login navigation", () => fakeRequest(`${ORIGIN}/admin/login`)],
    ["/adminx navigation", () => fakeRequest(`${ORIGIN}/adminx`)],
    ["/embed navigation", () => fakeRequest(`${ORIGIN}/embed/cluster/${ID}`)],
    ["/_vercel insights", () => fakeRequest(`${ORIGIN}/_vercel/insights/script.js`, { mode: "no-cors" })],
    ["/_next/image", () => fakeRequest(`${ORIGIN}/_next/image?url=%2Fa.png&w=64&q=75`, { mode: "no-cors" })],
    ["/sw.js itself", () => fakeRequest(`${ORIGIN}/sw.js`, { mode: "same-origin" })],
    ["POST", () => fakeRequest(`${ORIGIN}/cluster/${ID}`, { method: "POST" })],
    ["cross-origin navigation", () => fakeRequest(`https://evil.test/cluster/${ID}`)],
    ["cross-origin static", () => fakeRequest("https://cdn.test/_next/static/a.js", { mode: "no-cors" })],
    ["Range", () => fakeRequest(`${ORIGIN}/_next/static/media/a.mp4`, { mode: "no-cors", headers: { range: "bytes=0-1" } })],
    ["only-if-cached", () => fakeRequest(`${ORIGIN}/_next/static/a.js`, { mode: "cors", cache: "only-if-cached" })],
    ["RSC fetch", () => fakeRequest(`${ORIGIN}/cluster/${ID}?_rsc=abc`, { mode: "cors", headers: { rsc: "1" } })],
    ["analytics", () => fakeRequest("https://www.google-analytics.com/g/collect", { mode: "no-cors" })],
  ];

  it.each(cases)("%s: no respondWith, no fetch, no cache write", async (_name, make) => {
    const w = load(shellAwareFetch());
    const d = w.dispatchFetch(make());
    expect(d.responded).toBeNull();
    expect(d.respondWithCalls).toBe(0);
    await d.settled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Static: cache-first, hashed assets only
// ---------------------------------------------------------------------------

describe("static assets (cache-first)", () => {
  const assetUrl = (n: number | string) => `${ORIGIN}/_next/static/chunks/c${n}.js?dpl=d1`;
  const assetFetch: FetchImpl = async (input) => {
    const url = urlString(input);
    return fakeResponse("js:" + url, {
      url,
      headers: { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" },
    });
  };
  const staticReq = (url: string) => fakeRequest(url, { mode: "no-cors" });

  it("serves a hit without touching the network", async () => {
    const w = load(assetFetch);
    await w.caches.seed(CACHE_NAMES.static, assetUrl(1), fakeResponse("cached-js"));
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("cached-js");
    await d.settled();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("also serves assets precached into the shell cache", async () => {
    const w = load(assetFetch);
    await w.caches.seed(CACHE_NAMES.shell, ASSET_A, fakeResponse("shell-css"));
    const d = w.dispatchFetch(staticReq(ASSET_A));
    expect(await bodyOf(await d.responded)).toBe("shell-css");
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("does not read caches it does not own", async () => {
    const w = load(assetFetch);
    await w.caches.seed("other-lib", assetUrl(1), fakeResponse("foreign"));
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("js:" + assetUrl(1));
  });

  it("caches a miss (query kept) and returns the network body", async () => {
    const w = load(assetFetch);
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("js:" + assetUrl(1));
    await d.settled();
    expect(w.caches.urls(CACHE_NAMES.static)).toEqual([assetUrl(1)]);
    expect(await w.caches.text(CACHE_NAMES.static, assetUrl(1))).toBe("js:" + assetUrl(1));
  });

  it("does not cache a no-store response", async () => {
    const w = load(async (input) =>
      fakeResponse("x", { url: urlString(input), headers: { "content-type": "application/javascript", "cache-control": "no-store" } }),
    );
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("x");
    await d.settled();
    expect(w.caches.urls(CACHE_NAMES.static)).toEqual([]);
  });

  it.each([
    ["404", { status: 404 }],
    ["redirected", { redirected: true }],
    ["opaque", { type: "opaque" as ResponseType }],
  ])("does not cache a %s response", async (_n, over) => {
    const w = load(async (input) => fakeResponse("x", { url: urlString(input), ...over, headers: { "content-type": "text/css" } }));
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    await d.responded;
    await d.settled();
    expect(w.caches.urls(CACHE_NAMES.static)).toEqual([]);
  });

  it("trims the cache to staticMaxEntries (3), oldest first", async () => {
    const w = load(assetFetch);
    for (let i = 1; i <= 5; i++) {
      const d = w.dispatchFetch(staticReq(assetUrl(i)));
      await d.responded;
      await d.settled();
    }
    expect(w.caches.urls(CACHE_NAMES.static)).toEqual([assetUrl(3), assetUrl(4), assetUrl(5)]);
  });

  it("propagates a network failure (same as having no worker) and caches nothing", async () => {
    const w = load(async () => {
      throw new TypeError("offline");
    });
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    await expect(d.responded).rejects.toThrow("offline");
    await d.settled();
    expect(w.caches.urls(CACHE_NAMES.static)).toEqual([]);
  });

  it("falls back to the network when the cache itself breaks", async () => {
    const w = load(assetFetch);
    vi.spyOn(w.caches, "open").mockRejectedValue(new Error("QuotaExceededError"));
    vi.spyOn(w.caches, "match").mockRejectedValue(new Error("boom"));
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("js:" + assetUrl(1));
    await d.settled();
  });

  it("swallows a quota error while storing and still returns the response", async () => {
    const w = load(assetFetch);
    const cache = await w.caches.open(CACHE_NAMES.static);
    vi.spyOn(cache, "put").mockRejectedValue(new Error("QuotaExceededError"));
    const d = w.dispatchFetch(staticReq(assetUrl(1)));
    expect(await bodyOf(await d.responded)).toBe("js:" + assetUrl(1));
    await expect(d.settled()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Navigation: network-first with an explicit allowlist
// ---------------------------------------------------------------------------

describe("navigation: allowlisted cluster pages", () => {
  const nav = (id = ID, q = "") => fakeRequest(urlOf(id) + q);
  const seedPages = (w: LoadedWorker, id: string, body: string, cachedAt = iso(0)) =>
    w.caches.seed(CACHE_NAMES.pages, urlOf(id), stored(body, { [HEADER_CACHED_AT]: cachedAt }));
  const seedSaved = (w: LoadedWorker, id: string, body: string, cachedAt = iso(0)) =>
    w.caches.seed(CACHE_NAMES.saved, urlOf(id), stored(body, { [HEADER_CACHED_AT]: cachedAt, [HEADER_TITLE]: encodeURIComponent("Eski") }));
  const reject = async () => {
    throw new TypeError("Failed to fetch");
  };

  it("fast network (<500) wins over any cached copy and refreshes pages", async () => {
    const w = load(async () => pageRes(ID, page("Yeni")));
    await seedPages(w, ID, "OLD");
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toContain("Yeni");
    await d.settled();
    expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toContain("Yeni");
  });

  it("leaves no timer running once the network has answered", async () => {
    const w = load(async () => pageRes(ID, page("Hizli")));
    const d = w.dispatchFetch(nav());
    await d.responded;
    await d.settled();
    expect(w.pendingTimers()).toBe(0);

    const failing = load(reject);
    const f = failing.dispatchFetch(nav());
    await f.responded;
    await f.settled();
    expect(failing.pendingTimers()).toBe(0);
  });

  it("serves a network 404 as is (status < 500) and writes nothing", async () => {
    const w = load(async () => pageRes(ID, "gone", { status: 404 }));
    await seedPages(w, ID, "OLD");
    const d = w.dispatchFetch(nav());
    const res = (await d.responded) as Response;
    expect(res.status).toBe(404);
    await d.settled();
    expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toBe("OLD");
  });

  it("network 500 + cached copy -> cached copy", async () => {
    const w = load(async () => pageRes(ID, "ERR", { status: 500 }));
    await seedPages(w, ID, "OLD");
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("OLD");
  });

  it("network 500 + saved copy -> saved copy", async () => {
    const w = load(async () => pageRes(ID, "ERR", { status: 503 }));
    await seedSaved(w, ID, "PINNED");
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("PINNED");
  });

  it("network 500 + nothing cached -> the network 500", async () => {
    const w = load(async () => pageRes(ID, "ERR", { status: 500 }));
    const res = (await w.dispatchFetch(nav()).responded) as Response;
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("ERR");
  });

  it("network rejects + cached copy -> cached copy", async () => {
    const w = load(reject);
    await seedPages(w, ID, "OLD");
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("OLD");
  });

  it("network rejects + nothing cached -> the /offline shell", async () => {
    const w = load(reject);
    await seedShell(w);
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toContain("OFFLINE SHELL");
  });

  it("network rejects + nothing cached + no shell -> Response.error()", async () => {
    const w = load(reject);
    const res = (await w.dispatchFetch(nav()).responded) as Response;
    expect(res.type).toBe("error");
  });

  it("prefers the saved (pinned) copy over the pages copy", async () => {
    const w = load(reject);
    await seedPages(w, ID, "PAGES");
    await seedSaved(w, ID, "PINNED");
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("PINNED");
  });

  it("utm-tagged share links hit the same cache entry", async () => {
    const w = load(reject);
    await seedPages(w, ID, "OLD");
    const d = w.dispatchFetch(nav(ID.toUpperCase(), "?utm_source=twitter&utm_medium=social"));
    expect(await bodyOf(await d.responded)).toBe("OLD");
  });

  it("slow network + cached copy -> cached now; the network keeps running and updates the cache", async () => {
    const w = load(async () => {
      await sleep(100);
      return pageRes(ID, page("Gec gelen"));
    });
    await seedPages(w, ID, "OLD");
    const t0 = Date.now();
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toBe("OLD");
    expect(Date.now() - t0).toBeLessThan(90);
    expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toBe("OLD"); // not yet
    await d.settled();
    expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toContain("Gec gelen");
    expect(d.waits.length).toBeGreaterThan(0);
  });

  it("slow network + saved copy -> saved now, saved refreshed afterwards (not pages)", async () => {
    const w = load(async () => {
      await sleep(100);
      return pageRes(ID, page("Yeni baslik"));
    });
    await seedSaved(w, ID, "PINNED");
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toBe("PINNED");
    await d.settled();
    expect(await w.caches.text(CACHE_NAMES.saved, urlOf(ID))).toContain("Yeni baslik");
    expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
  });

  it("slow network + nothing cached -> keeps waiting and serves the network", async () => {
    const w = load(async () => {
      await sleep(100);
      return pageRes(ID, page("Yavas"));
    });
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toContain("Yavas");
    await d.settled();
    expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toContain("Yavas");
  });

  it("slow 500 + nothing cached -> the 500; slow reject + nothing cached -> /offline", async () => {
    const slow500 = load(async () => {
      await sleep(80);
      return pageRes(ID, "ERR", { status: 500 });
    });
    expect(((await slow500.dispatchFetch(nav()).responded) as Response).status).toBe(500);

    const slowReject = load(async () => {
      await sleep(80);
      throw new TypeError("late failure");
    });
    await seedShell(slowReject);
    expect(await bodyOf(await slowReject.dispatchFetch(nav()).responded)).toContain("OFFLINE SHELL");
  });

  it("a rejected background fetch after the timeout raises no unhandled rejection", async () => {
    const w = load(async () => {
      await sleep(80);
      throw new TypeError("late failure");
    });
    await seedPages(w, ID, "OLD");
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toBe("OLD");
    await expect(d.settled()).resolves.toBeUndefined();
  });

  it("a 15-day-old pages entry is not served: falls back to /offline and is deleted", async () => {
    const w = load(reject);
    await seedShell(w);
    await seedPages(w, ID, "STALE", iso(15 * DAY));
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toContain("OFFLINE SHELL");
    await d.settled();
    expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
  });

  it("a 13-day-old pages entry is still served", async () => {
    const w = load(reject);
    await seedPages(w, ID, "FRESHISH", iso(13 * DAY));
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("FRESHISH");
  });

  it("a pages entry with no cached-at stamp counts as expired", async () => {
    const w = load(reject);
    await seedShell(w);
    await w.caches.seed(CACHE_NAMES.pages, urlOf(ID), stored("NOSTAMP"));
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toContain("OFFLINE SHELL");
  });

  it("a saved (pinned) entry never expires", async () => {
    const w = load(reject);
    await seedSaved(w, ID, "PINNED-OLD", iso(400 * DAY));
    expect(await bodyOf(await w.dispatchFetch(nav()).responded)).toBe("PINNED-OLD");
  });

  describe("write-back", () => {
    it("keeps CSP, adds cached-at and drops vary/content-encoding/cache-control", async () => {
      const w = load(async () =>
        pageRes(ID, page("Başlık"), { headers: { "content-encoding": "identity", "x-frame-options": "DENY" } }),
      );
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      const h = await w.caches.headers(CACHE_NAMES.pages, urlOf(ID));
      expect(h).not.toBeNull();
      expect(h?.get("content-security-policy")).toBe(CSP);
      expect(h?.get("x-frame-options")).toBe("DENY");
      expect(h?.get("content-type")).toContain("text/html");
      expect(Date.parse(h?.get(HEADER_CACHED_AT) ?? "")).toBeGreaterThan(Date.now() - 5000);
      expect(h?.has("vary")).toBe(false);
      expect(h?.has("content-encoding")).toBe(false);
      expect(h?.has("cache-control")).toBe(false);
      expect(h?.has(HEADER_TITLE)).toBe(false); // pages entries carry no title
    });

    it("refreshes the saved cache (with a decoded title header) for a pinned key, not pages", async () => {
      const w = load(async () => pageRes(ID, page("Şehirde özel gelişme")));
      await seedSaved(w, ID, "PINNED");
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
      expect(await w.caches.text(CACHE_NAMES.saved, urlOf(ID))).toContain("Şehirde özel gelişme");
      const h = await w.caches.headers(CACHE_NAMES.saved, urlOf(ID));
      expect(decodeURIComponent(h?.get(HEADER_TITLE) ?? "")).toBe("Şehirde özel gelişme");
      expect(h?.get("content-security-policy")).toBe(CSP);
    });

    it.each(SHELLS)("a 200 %s is shown but never written to pages", async (_n, shell) => {
      const w = load(async () => pageRes(ID, shell));
      const d = w.dispatchFetch(nav());
      expect(await bodyOf(await d.responded)).toBe(shell);
      await d.settled();
      expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
    });

    it.each(SHELLS)("a 200 %s leaves a pinned copy untouched", async (_n, shell) => {
      const w = load(async () => pageRes(ID, shell));
      await seedSaved(w, ID, "PINNED-GOOD", iso(2 * DAY));
      const before = (await w.caches.headers(CACHE_NAMES.saved, urlOf(ID)))?.get(HEADER_CACHED_AT);
      w.caches.clearLog();
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      expect(await w.caches.text(CACHE_NAMES.saved, urlOf(ID))).toBe("PINNED-GOOD");
      const h = await w.caches.headers(CACHE_NAMES.saved, urlOf(ID));
      expect(decodeURIComponent(h?.get(HEADER_TITLE) ?? "")).toBe("Eski");
      expect(h?.get(HEADER_CACHED_AT)).toBe(before);
      expect(w.caches.writes().filter((op) => op.op === "put" || op.op === "delete")).toEqual([]);
    });

    it.each(SHELLS)("a 200 %s leaves an existing pages copy untouched", async (_n, shell) => {
      const w = load(async () => pageRes(ID, shell));
      await seedPages(w, ID, "PAGES-GOOD");
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toBe("PAGES-GOOD");
    });

    it("a stored error shell cannot come back later: after a failed visit, the origin being down gives /offline", async () => {
      let down = false;
      const w = load(async () => (down ? reject() : pageRes(ID, ERROR_SHELL)));
      await seedShell(w);
      const first = w.dispatchFetch(nav());
      await first.responded;
      await first.settled();
      down = true;
      const second = w.dispatchFetch(nav());
      expect(await bodyOf(await second.responded)).toBe("<html>OFFLINE SHELL</html>");
    });

    it("a real story (og:type article) is still stored in pages", async () => {
      const w = load(async () => pageRes(ID, page("Gerçek haber")));
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      expect(await w.caches.text(CACHE_NAMES.pages, urlOf(ID))).toContain("Gerçek haber");
    });

    it("trims pages to pagesMaxEntries (2), oldest first", async () => {
      const ids = [ID, ID2, ID3];
      const w = load(async (input) => {
        const id = urlString(input).split("/").pop() as string;
        return pageRes(id, page("t" + id.slice(0, 4)));
      });
      for (const id of ids) {
        const d = w.dispatchFetch(nav(id));
        await d.responded;
        await d.settled();
      }
      expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([urlOf(ID2), urlOf(ID3)]);
    });

    it.each([
      ["Set-Cookie", { headers: { "set-cookie": "a=b" } }],
      ["redirected", { redirected: true }],
      ["non-basic", { type: "cors" as ResponseType }],
      ["non-html", { headers: { "content-type": "application/json" } }],
    ])("does not cache a response with %s", async (_n, over) => {
      const w = load(async () => pageRes(ID, "<p>x</p>", over));
      const d = w.dispatchFetch(nav());
      await d.responded;
      await d.settled();
      expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
    });

    it("a quota error while writing back is swallowed; the page still loads", async () => {
      const w = load(async () => pageRes(ID, page("Q")));
      const cache = await w.caches.open(CACHE_NAMES.pages);
      vi.spyOn(cache, "put").mockRejectedValue(new Error("QuotaExceededError"));
      const d = w.dispatchFetch(nav());
      expect(await bodyOf(await d.responded)).toContain("Q");
      await expect(d.settled()).resolves.toBeUndefined();
    });

    it("the page the browser receives is not consumed by the write-back clone", async () => {
      const big = page("Büyük", "x".repeat(200_000));
      const w = load(async () => pageRes(ID, big));
      const d = w.dispatchFetch(nav());
      expect((await bodyOf(await d.responded)).length).toBe(big.length);
      await d.settled();
      expect((await w.caches.text(CACHE_NAMES.pages, urlOf(ID)))?.length).toBe(big.length);
    });
  });

  it("a broken cache never breaks the network path (online)", async () => {
    const w = load(async () => pageRes(ID, page("Ağ")));
    vi.spyOn(w.caches, "open").mockRejectedValue(new Error("boom"));
    const d = w.dispatchFetch(nav());
    expect(await bodyOf(await d.responded)).toContain("Ağ");
    await expect(d.settled()).resolves.toBeUndefined();
  });

  it("a broken cache while offline ends in Response.error(), never a thrown error", async () => {
    const w = load(reject);
    vi.spyOn(w.caches, "open").mockRejectedValue(new Error("boom"));
    const res = (await w.dispatchFetch(nav()).responded) as Response;
    expect(res.type).toBe("error");
  });
});

describe("navigation: everything else", () => {
  it("passes a non-allowlisted page through to the network and writes nothing", async () => {
    const w = load(async () => fakeResponse(page("Ana"), { url: `${ORIGIN}/`, headers: { "content-type": "text/html" } }));
    const d = w.dispatchFetch(fakeRequest(`${ORIGIN}/`));
    expect(await bodyOf(await d.responded)).toContain("Ana");
    await d.settled();
    expect(w.caches.writes()).toEqual([]);
  });

  it("passes a 500 through untouched", async () => {
    const w = load(async () => fakeResponse("err", { status: 500, url: `${ORIGIN}/` }));
    expect(((await w.dispatchFetch(fakeRequest(`${ORIGIN}/`)).responded) as Response).status).toBe(500);
  });

  it("does not cache /cluster/<id>/kart or other sub-pages", async () => {
    const w = load(async (input) => fakeResponse("<html>", { url: urlString(input), headers: { "content-type": "text/html" } }));
    const d = w.dispatchFetch(fakeRequest(`${urlOf(ID)}/kart`));
    await d.responded;
    await d.settled();
    expect(w.caches.writes()).toEqual([]);
  });

  it("offline: a non-cluster navigation gets the /offline shell", async () => {
    const w = load(async () => {
      throw new TypeError("offline");
    });
    await seedShell(w);
    expect(await bodyOf(await w.dispatchFetch(fakeRequest(`${ORIGIN}/ekonomi`)).responded)).toContain("OFFLINE SHELL");
  });

  it("offline with no shell cached: Response.error()", async () => {
    const w = load(async () => {
      throw new TypeError("offline");
    });
    const res = (await w.dispatchFetch(fakeRequest(`${ORIGIN}/ekonomi`)).responded) as Response;
    expect(res.type).toBe("error");
  });

  it("does not serve a stale cluster copy for a different cluster", async () => {
    const w = load(async () => {
      throw new TypeError("offline");
    });
    await seedShell(w);
    await w.caches.seed(CACHE_NAMES.pages, urlOf(ID), stored("OTHER", { [HEADER_CACHED_AT]: iso(0) }));
    expect(await bodyOf(await w.dispatchFetch(fakeRequest(urlOf(ID2))).responded)).toContain("OFFLINE SHELL");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("install", () => {
  it("precaches /offline plus its same-origin assets (query kept) and calls skipWaiting", async () => {
    const w = load(shellAwareFetch());
    await w.dispatchInstall();

    const keys = w.caches.urls(CACHE_NAMES.shell).sort();
    expect(keys).toEqual([ASSET_A, ASSET_B, `${ORIGIN}/offline`].sort());
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);

    const fetched = w.fetch.mock.calls.map((c) => urlString(c[0]));
    expect(fetched).toContain(`${ORIGIN}/offline`);
    expect(fetched.some((u) => u.includes("cdn.test"))).toBe(false); // cross-origin asset ignored
    const offlineCall = w.fetch.mock.calls.find((c) => urlString(c[0]) === `${ORIGIN}/offline`);
    expect(offlineCall?.[1]).toMatchObject({ cache: "no-cache" });

    const h = await w.caches.headers(CACHE_NAMES.shell, `${ORIGIN}/offline`);
    expect(h?.get("content-security-policy")).toBe(CSP);
    expect(h?.get(HEADER_CACHED_AT)).toBeTruthy();
    expect(await w.caches.text(CACHE_NAMES.shell, `${ORIGIN}/offline`)).toBe(OFFLINE_HTML);
  });

  it.each([
    ["a rejected fetch", async () => Promise.reject(new TypeError("offline"))],
    ["a 404", async (input: string | Request) => fakeResponse("nope", { status: 404, url: urlString(input), headers: { "content-type": "text/html" } })],
    ["a 500", async (input: string | Request) => fakeResponse("nope", { status: 500, url: urlString(input), headers: { "content-type": "text/html" } })],
    ["a redirect", async (input: string | Request) => fakeResponse("<html>", { redirected: true, url: urlString(input), headers: { "content-type": "text/html" } })],
    ["non-HTML", async (input: string | Request) => fakeResponse("{}", { url: urlString(input), headers: { "content-type": "application/json" } })],
    ["a response with Set-Cookie", async (input: string | Request) => fakeResponse("<html>", { url: urlString(input), headers: { "content-type": "text/html", "set-cookie": "a=b" } })],
    ["a different final url", async () => fakeResponse("<html>", { url: `${ORIGIN}/login`, headers: { "content-type": "text/html" } })],
  ] as Array<[string, FetchImpl]>)("fails the install on %s (retried on the next load) and does not skipWaiting", async (_n, impl) => {
    const w = load(impl);
    await expect(w.dispatchInstall()).rejects.toBeDefined();
    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.caches.urls(CACHE_NAMES.shell)).toEqual([]);
  });

  it("still installs when an individual asset fails or is no-store", async () => {
    const w = load(
      shellAwareFetch(),
    );
    const base = w.fetch.getMockImplementation() as FetchImpl;
    w.fetch.mockImplementation(async (input, init) => {
      const url = urlString(input);
      if (url === ASSET_A) throw new TypeError("asset offline");
      if (url === ASSET_B) {
        return fakeResponse("b", { url, headers: { "content-type": "text/css", "cache-control": "no-store" } });
      }
      return base(input, init);
    });
    await w.dispatchInstall();
    expect(w.caches.urls(CACHE_NAMES.shell)).toEqual([`${ORIGIN}/offline`]);
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("drops shell keys that are not in the new set, keeps the new ones", async () => {
    const w = load(shellAwareFetch());
    await w.caches.seed(CACHE_NAMES.shell, `${ORIGIN}/_next/static/chunks/old.js`, fakeResponse("old"));
    await w.dispatchInstall();
    expect(w.caches.urls(CACHE_NAMES.shell)).not.toContain(`${ORIGIN}/_next/static/chunks/old.js`);
    expect(w.caches.urls(CACHE_NAMES.shell)).toContain(ASSET_A);
  });
});

describe("activate", () => {
  // The worker never claims clients: claiming a first visit that is still loading would re-issue its in-flight
  // preloads through the worker. skipWaiting() at install already moves pages controlled by an older version over.
  it("drops old versioned tayf- caches, keeps current ones, tayf-saved-v1 and foreign caches, and never claims", async () => {
    const w = load();
    for (const name of [
      "tayf-static-v0", "tayf-pages-v0", "tayf-shell-v0", "tayf-meta-v0", CACHE_NAMES.static, CACHE_NAMES.pages,
      CACHE_NAMES.shell, CACHE_NAMES.meta, "tayf-saved-v1", "other-lib",
    ]) {
      await w.caches.seed(name, `${ORIGIN}/x`, fakeResponse("x"));
    }
    await w.dispatchActivate();
    expect(w.caches.cacheNames().sort()).toEqual(
      [CACHE_NAMES.static, CACHE_NAMES.pages, CACHE_NAMES.shell, CACHE_NAMES.meta, "tayf-saved-v1", "other-lib"].sort(),
    );
    expect(w.claim).not.toHaveBeenCalled();
  });

  it("still resolves, and still does not claim, when listing caches fails", async () => {
    const w = load();
    vi.spyOn(w.caches, "keys").mockRejectedValue(new Error("boom"));
    await w.dispatchActivate(); // a rejection here would fail the test
    expect(w.claim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Messages: pin / unpin / sync
// ---------------------------------------------------------------------------

describe("messages", () => {
  const html = (title: string) => page(title);
  const clusterFetch: FetchImpl = async (input) => {
    const url = urlString(input);
    const id = url.split("/").pop() as string;
    return pageRes(id, html("Şehirde özel gelişme"));
  };

  it("pin fetches exactly the cluster url and stores it with a decoded title and cached-at", async () => {
    const w = load(clusterFetch);
    await w.dispatchMessage({ type: "tayf:pin", id: ID.toUpperCase() });

    expect(w.fetch).toHaveBeenCalledTimes(1);
    const [input, init] = w.fetch.mock.calls[0] as [string | Request, RequestInit];
    expect(urlString(input)).toBe(urlOf(ID));
    expect(init).toMatchObject({ credentials: "same-origin" });
    expect(new Headers(init.headers).get("accept")).toBe("text/html");

    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID)]);
    const h = await w.caches.headers(CACHE_NAMES.saved, urlOf(ID));
    expect(decodeURIComponent(h?.get(HEADER_TITLE) ?? "")).toBe("Şehirde özel gelişme");
    expect(h?.get(HEADER_CACHED_AT)).toBeTruthy();
    expect(h?.get("content-security-policy")).toBe(CSP);
  });

  it("pin never trusts a url sent by the page", async () => {
    const w = load(clusterFetch);
    await w.dispatchMessage({ type: "tayf:pin", id: ID, url: "https://evil.test/steal", href: "/admin" });
    expect(w.fetch.mock.calls.map((c) => urlString(c[0]))).toEqual([urlOf(ID)]);
  });

  it.each(["../admin", "", `${ID}/../../admin`, "/cluster/" + ID, "not-a-uuid"])("pin with an invalid id %j calls no fetch and writes nothing", async (id) => {
    const w = load(clusterFetch);
    await w.dispatchMessage({ type: "tayf:pin", id });
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.writes()).toEqual([]);
  });

  it("pin stores nothing when the response is not cacheable", async () => {
    for (const make of [
      (id: string) => pageRes(id, "x", { status: 404 }),
      (id: string) => pageRes(id, "x", { redirected: true }),
      (id: string) => pageRes(id, "x", { headers: { "set-cookie": "a=b" } }),
      (id: string) => pageRes(id, "x", { headers: { "content-type": "application/json" } }),
    ]) {
      const w = load(async (input) => make(urlString(input).split("/").pop() as string));
      await w.dispatchMessage({ type: "tayf:pin", id: ID });
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
    }
  });

  it.each(SHELLS)("pin stores nothing for a 200 %s", async (_n, shell) => {
    const w = load(async (input) => pageRes(urlString(input).split("/").pop() as string, shell));
    await w.dispatchMessage({ type: "tayf:pin", id: ID });
    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
  });

  it.each(SHELLS)("pin never overwrites an existing saved copy with a 200 %s", async (_n, shell) => {
    const w = load(async (input) => pageRes(urlString(input).split("/").pop() as string, shell));
    await w.caches.seed(
      CACHE_NAMES.saved,
      urlOf(ID),
      stored("PINNED-GOOD", { [HEADER_CACHED_AT]: iso(DAY), [HEADER_TITLE]: encodeURIComponent("Eski") }),
    );
    await w.dispatchMessage({ type: "tayf:pin", id: ID });
    expect(await w.caches.text(CACHE_NAMES.saved, urlOf(ID))).toBe("PINNED-GOOD");
  });

  it("pin swallows a network failure", async () => {
    const w = load(async () => {
      throw new TypeError("offline");
    });
    await expect(w.dispatchMessage({ type: "tayf:pin", id: ID })).resolves.toBeUndefined();
    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
  });

  it("pin trims the saved cache to savedMaxEntries (2), oldest first", async () => {
    const w = load(clusterFetch);
    for (const id of [ID, ID2, ID3]) await w.dispatchMessage({ type: "tayf:pin", id });
    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID2), urlOf(ID3)]);
  });

  it("unpin deletes only that saved entry", async () => {
    const w = load(clusterFetch);
    await w.dispatchMessage({ type: "tayf:pin", id: ID });
    await w.dispatchMessage({ type: "tayf:pin", id: ID2 });
    await w.dispatchMessage({ type: "tayf:unpin", id: ID.toUpperCase() });
    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID2)]);
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("unpin with an invalid id deletes nothing", async () => {
    const w = load(clusterFetch);
    await w.dispatchMessage({ type: "tayf:pin", id: ID });
    w.caches.clearLog();
    await w.dispatchMessage({ type: "tayf:unpin", id: "../admin" });
    expect(w.caches.writes()).toEqual([]);
    expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID)]);
  });

  describe("sync", () => {
    const big = { savedMaxEntries: 20 };

    it("prunes absent ids, warms at most 3 missing ids and does so sequentially", async () => {
      const { wrapped, state } = trackConcurrency(async (input: string | Request) => {
        await sleep(10);
        return clusterFetch(input);
      });
      const w = load(wrapped, big);
      await seedShell(w); // fresh shell: no /offline refresh
      for (const id of [ID, ID2, ID3]) await w.caches.seed(CACHE_NAMES.saved, urlOf(id), stored("OLD-" + id.slice(0, 4), { [HEADER_CACHED_AT]: iso(0) }));

      // keep ID2, drop ID and ID3, ask for 5 missing ids (only 3 may be warmed, newest bookmark first)
      await w.dispatchMessage({ type: "tayf:sync", ids: [ID2, ID4, ID5, ID6, ID7, ID8] });

      const saved = w.caches.urls(CACHE_NAMES.saved);
      expect(saved).not.toContain(urlOf(ID));
      expect(saved).not.toContain(urlOf(ID3));
      expect(saved).toContain(urlOf(ID2));
      expect(await w.caches.text(CACHE_NAMES.saved, urlOf(ID2))).toBe("OLD-1111"); // existing entry not refetched
      expect(state.calls).toBe(3);
      expect(state.max).toBe(1);
      expect(w.fetch.mock.calls.map((c) => urlString(c[0]))).toEqual([urlOf(ID8), urlOf(ID7), urlOf(ID6)]);
      expect(saved).toHaveLength(4); // ID2 + 3 warmed
    });

    it("an empty id list prunes every saved entry", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.saved, urlOf(ID), stored("x"));
      await w.dispatchMessage({ type: "tayf:sync", ids: [] });
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
      expect(w.fetch).not.toHaveBeenCalled();
    });

    it("ignores invalid ids in the list", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.dispatchMessage({ type: "tayf:sync", ids: ["../admin", ID, 5, null] });
      expect(w.fetch.mock.calls.map((c) => urlString(c[0]))).toEqual([urlOf(ID)]);
    });

    it("keeps going when one warm fails", async () => {
      const w = load(async (input) => {
        if (urlString(input) === urlOf(ID4)) throw new TypeError("offline");
        return clusterFetch(input);
      }, big);
      await seedShell(w);
      await w.dispatchMessage({ type: "tayf:sync", ids: [ID4, ID5] });
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID5)]);
    });

    // ---- unstorable ids (merged / deleted / failing clusters) must not starve or hammer ----

    const idOf = (input: string | Request) => urlString(input).split("/").pop() as string;
    /** Per-id answers: a merged cluster (308 followed), a 404, the 200 error shell, the 200 not-found shell, or a story. */
    const unstorable = {
      merged: (id: string) => pageRes(id, "x", { redirected: true }),
      gone: (id: string) => pageRes(id, "x", { status: 404 }),
      broken: (id: string) => pageRes(id, "x", { status: 500 }),
      errorShell: (id: string) => pageRes(id, ERROR_SHELL),
      notFoundShell: (id: string) => pageRes(id, NOT_FOUND_SHELL),
    };
    type Kind = keyof typeof unstorable;
    const kinds = Object.keys(unstorable) as Kind[];
    const routed = (dead: Record<string, Kind>): FetchImpl => async (input) => {
      const id = idOf(input);
      const kind = dead[id];
      return kind ? unstorable[kind](id) : clusterFetch(input);
    };
    const fetched = (w: LoadedWorker) => w.fetch.mock.calls.map((c) => urlString(c[0]));
    const sync = (w: LoadedWorker, ids: string[]) => w.dispatchMessage({ type: "tayf:sync", ids });

    it("warms the newest bookmarks first", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await sync(w, [ID, ID2, ID3, ID4, ID5]);
      expect(fetched(w)).toEqual([urlOf(ID5), urlOf(ID4), urlOf(ID3)]);
    });

    it("three old unstorable ids do not stop a newer valid id from being warmed", async () => {
      const w = load(routed({ [ID]: "merged", [ID2]: "gone", [ID3]: "errorShell" }), big);
      await seedShell(w);
      await sync(w, [ID, ID2, ID3, ID4]);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID4)]);
    });

    it.each(kinds)("a %s id is fetched once, then skipped on later syncs while the older valid id gets its turn", async (kind) => {
      const dead: Record<string, Kind> = { [ID2]: kind, [ID3]: kind, [ID4]: kind };
      const w = load(routed(dead), big);
      await seedShell(w);

      await sync(w, [ID, ID2, ID3, ID4]); // newest three are dead: all three attempts burn on them
      expect(fetched(w)).toEqual([urlOf(ID4), urlOf(ID3), urlOf(ID2)]);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);

      w.fetch.mockClear();
      await sync(w, [ID, ID2, ID3, ID4]);
      expect(fetched(w)).toEqual([urlOf(ID)]); // the dead ids cost no render and no warm slot
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID)]);

      w.fetch.mockClear();
      await sync(w, [ID, ID2, ID3, ID4]);
      expect(w.fetch).not.toHaveBeenCalled();
    });

    it("at most syncWarmMax ids are attempted per sync even when every one fails, and the list is worked through", async () => {
      const dead: Record<string, Kind> = Object.fromEntries([ID, ID2, ID3, ID4, ID5].map((id) => [id, "gone" as Kind]));
      const w = load(routed(dead), big);
      await seedShell(w);
      const all = [ID, ID2, ID3, ID4, ID5];
      await sync(w, all);
      expect(fetched(w)).toEqual([urlOf(ID5), urlOf(ID4), urlOf(ID3)]);
      w.fetch.mockClear();
      await sync(w, all);
      expect(fetched(w)).toEqual([urlOf(ID2), urlOf(ID)]);
      w.fetch.mockClear();
      await sync(w, all);
      expect(w.fetch).not.toHaveBeenCalled();
    });

    it("records the failed attempt with a cached-at stamp in the meta cache, never in saved or pages", async () => {
      const w = load(routed({ [ID]: "merged" }), big);
      await seedShell(w);
      await sync(w, [ID]);
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([urlOf(ID)]);
      const h = await w.caches.headers(CACHE_NAMES.meta, urlOf(ID));
      expect(Date.now() - Date.parse(h?.get(HEADER_CACHED_AT) ?? "")).toBeLessThan(5000);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([]);
      expect(w.caches.urls(CACHE_NAMES.pages)).toEqual([]);
    });

    it("a recent marker skips the id; one older than warmRetryMs is retried", async () => {
      const retry = policy.SW_CONFIG.warmRetryMs;
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID), stored("", { [HEADER_CACHED_AT]: iso(retry - HOUR) }));
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID2), stored("", { [HEADER_CACHED_AT]: iso(retry + HOUR) }));
      await sync(w, [ID, ID2]);
      expect(fetched(w)).toEqual([urlOf(ID2)]);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID2)]);
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([urlOf(ID)]); // the stale marker went away with the successful pin
    });

    it("a marker without a usable stamp counts as expired", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID), stored(""));
      await sync(w, [ID]);
      expect(fetched(w)).toEqual([urlOf(ID)]);
    });

    it("a network failure (offline) is not remembered: the id is retried on the next sync", async () => {
      let offline = true;
      const w = load(async (input) => (offline ? Promise.reject(new TypeError("offline")) : clusterFetch(input)), big);
      await seedShell(w);
      await sync(w, [ID]);
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([]);
      offline = false;
      await sync(w, [ID]);
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID)]);
    });

    it("a successful pin clears a stale marker", async () => {
      const w = load(clusterFetch, big);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID), stored("", { [HEADER_CACHED_AT]: iso(HOUR) }));
      await w.dispatchMessage({ type: "tayf:pin", id: ID }); // an explicit pin ignores markers
      expect(w.caches.urls(CACHE_NAMES.saved)).toEqual([urlOf(ID)]);
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([]);
    });

    it("a failed explicit pin is remembered, so the next sync does not refetch it", async () => {
      const w = load(routed({ [ID]: "notFoundShell" }), big);
      await seedShell(w);
      await w.dispatchMessage({ type: "tayf:pin", id: ID });
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([urlOf(ID)]);
      w.fetch.mockClear();
      await sync(w, [ID]);
      expect(w.fetch).not.toHaveBeenCalled();
    });

    it("unpin clears the marker", async () => {
      const w = load(clusterFetch, big);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID), stored("", { [HEADER_CACHED_AT]: iso(0) }));
      await w.dispatchMessage({ type: "tayf:unpin", id: ID });
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([]);
    });

    it("sync drops markers of ids that are no longer bookmarked", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID), stored("", { [HEADER_CACHED_AT]: iso(0) }));
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID2), stored("", { [HEADER_CACHED_AT]: iso(0) }));
      await sync(w, [ID2]);
      expect(w.caches.urls(CACHE_NAMES.meta)).toEqual([urlOf(ID2)]);
    });

    it("a broken meta cache never fails the sync: the warm still runs", async () => {
      const w = load(clusterFetch, big);
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.meta, urlOf(ID2), stored("", { [HEADER_CACHED_AT]: iso(0) })); // so the cache exists
      const realOpen = w.caches.open.bind(w.caches);
      vi.spyOn(w.caches, "open").mockImplementation(async (name: string) => {
        if (name === CACHE_NAMES.meta) throw new Error("boom");
        return realOpen(name);
      });
      await expect(sync(w, [ID, ID2])).resolves.toBeUndefined();
      expect(w.caches.urls(CACHE_NAMES.saved).sort()).toEqual([urlOf(ID), urlOf(ID2)].sort());
    });

    it("only the newest savedMaxEntries bookmarks are wanted, so the saved cache does not churn", async () => {
      const w = load(clusterFetch, { savedMaxEntries: 3 });
      await seedShell(w);
      await w.caches.seed(CACHE_NAMES.saved, urlOf(ID), stored("OLDEST", { [HEADER_CACHED_AT]: iso(0) }));
      const all = [ID, ID2, ID3, ID4, ID5];

      await sync(w, all);
      expect(w.caches.urls(CACHE_NAMES.saved).sort()).toEqual([urlOf(ID3), urlOf(ID4), urlOf(ID5)].sort());
      expect(fetched(w)).toEqual([urlOf(ID5), urlOf(ID4), urlOf(ID3)]);

      w.fetch.mockClear();
      w.caches.clearLog();
      await sync(w, all);
      expect(w.fetch).not.toHaveBeenCalled();
      expect(w.caches.writes().filter((op) => op.cache === CACHE_NAMES.saved && op.op !== "open")).toEqual([]);
    });

    it("refreshes an expired /offline shell (best effort) after pruning and warming", async () => {
      const w = load(shellAwareFetch(clusterFetch), big);
      await seedShell(w, iso(8 * DAY));
      await w.dispatchMessage({ type: "tayf:sync", ids: [] });
      const fetched = w.fetch.mock.calls.map((c) => urlString(c[0]));
      expect(fetched).toContain(`${ORIGIN}/offline`);
      const h = await w.caches.headers(CACHE_NAMES.shell, `${ORIGIN}/offline`);
      expect(Date.now() - Date.parse(h?.get(HEADER_CACHED_AT) ?? "")).toBeLessThan(5000);
    });

    it("does not refetch a fresh /offline shell", async () => {
      const w = load(shellAwareFetch(clusterFetch), big);
      await seedShell(w, iso(6 * DAY));
      await w.dispatchMessage({ type: "tayf:sync", ids: [] });
      expect(w.fetch).not.toHaveBeenCalled();
    });

    it("a failing shell refresh does not fail the sync", async () => {
      const w = load(async () => {
        throw new TypeError("offline");
      }, big);
      await seedShell(w, iso(30 * DAY));
      await expect(w.dispatchMessage({ type: "tayf:sync", ids: [] })).resolves.toBeUndefined();
    });
  });

  it.each([
    null,
    undefined,
    42,
    "tayf:pin",
    true,
    [],
    {},
    { type: "tayf:pin" },
    { type: "tayf:pin", id: { toString: () => ID } },
    { type: "tayf:sync", ids: 5 },
    { type: "tayf:sync", ids: { length: 3 } },
    { type: "tayf:other", id: ID },
    { type: ["tayf:pin"], id: ID },
    Object.create(null),
    new Proxy({}, { get() { throw new Error("hostile"); } }),
  ])("garbage message %# is ignored without throwing, fetching or writing", async (data) => {
    const w = load(clusterFetch);
    await expect(w.dispatchMessage(data)).resolves.toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("kill mode", () => {
  const killSource = buildServiceWorkerSource({ kill: true });

  async function seeded() {
    const w = loadWorker({ source: killSource, fetch: async () => Promise.reject(new Error("no fetch in kill mode")) });
    for (const name of [
      CACHE_NAMES.static, CACHE_NAMES.pages, CACHE_NAMES.shell, "tayf-saved-v1", "tayf-static-v0", "other-lib",
    ]) {
      await w.caches.seed(name, `${ORIGIN}/x`, fakeResponse("x"));
    }
    return w;
  }

  it("registers only install and activate (no fetch, no message listener)", async () => {
    const w = await seeded();
    expect(w.listenerTypes().sort()).toEqual(["activate", "install"]);
    expect(w.hasListener("fetch")).toBe(false);
    expect(w.hasListener("message")).toBe(false);
  });

  it("does not respond to fetches", async () => {
    const w = await seeded();
    const d = w.dispatchFetch(fakeRequest(urlOf(ID)));
    expect(d.responded).toBeNull();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("install skips waiting", async () => {
    const w = await seeded();
    await w.dispatchInstall();
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("activate deletes every tayf- cache but not foreign ones, then unregisters exactly once", async () => {
    const w = await seeded();
    await w.dispatchActivate();
    expect(w.caches.cacheNames()).toEqual(["other-lib"]);
    expect(w.unregister).toHaveBeenCalledTimes(1);
    expect(w.claim).not.toHaveBeenCalled();
  });

  it("unregisters even when deleting caches fails", async () => {
    const w = await seeded();
    vi.spyOn(w.caches, "keys").mockRejectedValue(new Error("boom"));
    await w.dispatchActivate();
    expect(w.unregister).toHaveBeenCalledTimes(1);
  });

  it("never navigates clients (no reload loops)", () => {
    expect(killSource).not.toContain("navigate(");
    expect(killSource).not.toContain("clients");
  });
});
