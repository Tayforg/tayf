import { describe, it, expect } from "vitest";

import {
  CACHE_NAMES,
  HEADER_CACHED_AT,
  HEADER_TITLE,
  SYNC_MAX_IDS,
} from "./sw-contract";
import {
  COPIED_PAGE_HEADERS,
  SW_CONFIG,
  buildStoredHeaders,
  cachesToDelete,
  classifyRequest,
  extractShellAssets,
  extractTitle,
  isBypassedPath,
  isCacheableResponse,
  isExpired,
  isStoryHtml,
  pageCacheKey,
  parseMessage,
  planTrim,
} from "./sw-policy";

const ORIGIN = "https://tayf.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_UPPER = ID.toUpperCase();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function req(over: Partial<Parameters<typeof classifyRequest>[0]> = {}) {
  return { method: "GET", url: `${ORIGIN}/`, mode: "navigate", ...over };
}

function headers(init: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(init)) lower[k.toLowerCase()] = v;
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

function res(over: Record<string, unknown> = {}, h: Record<string, string> = {}) {
  return {
    status: 200,
    type: "basic",
    redirected: false,
    url: `${ORIGIN}/cluster/${ID}`,
    headers: headers({ "content-type": "text/html; charset=utf-8", ...h }),
    ...over,
  } as Parameters<typeof isCacheableResponse>[0];
}

describe("SW_CONFIG", () => {
  it("carries the documented limits", () => {
    expect(SW_CONFIG).toMatchObject({
      version: "v1",
      cachePrefix: "tayf-",
      offlinePath: "/offline",
      swUrl: "/sw.js",
      navTimeoutMs: 3000,
      pinTimeoutMs: 10000,
      pagesMaxEntries: 60,
      pagesMaxAgeMs: 14 * DAY,
      staticMaxEntries: 300,
      savedMaxEntries: 100,
      shellMaxAssets: 60,
      shellMaxAgeMs: 7 * DAY,
      syncWarmMax: 3,
      warmRetryMs: 12 * HOUR,
      syncMaxIds: SYNC_MAX_IDS,
    });
    expect(SW_CONFIG.caches).toEqual(CACHE_NAMES);
  });
});

describe("isBypassedPath", () => {
  it.each([
    ["/api", true],
    ["/api/x", true],
    ["/API/x", true],
    ["/api/v1/clusters", true],
    ["/embed", true],
    ["/embed/cluster/" + ID, true],
    ["/_vercel", true],
    ["/_vercel/insights/script.js", true],
    ["/admin", true],
    ["/admin/login", true],
    ["/ADMIN/x", true],
    ["/adminx", true], // anything starting with /admin
    ["/sw.js", true],
    ["/SW.JS", true],
    ["/_next/image", true],
    ["/_next/data/abc/x.json", true],
    ["/_next", true],
    ["/_next/static/chunks/a.js", false],
    ["/", false],
    ["/cluster/" + ID, false],
    ["/apix", false], // sibling, not a child of /api
    ["/embedded", false],
    ["/offline", false],
    ["/sw.json", false],
  ])("%s -> %s", (path, expected) => {
    expect(isBypassedPath(path)).toBe(expected);
  });
});

describe("classifyRequest", () => {
  it.each([
    ["POST", { method: "POST" }],
    ["PUT navigation", { method: "PUT", mode: "navigate" }],
    ["cross-origin", { url: "https://evil.test/cluster/" + ID }],
    ["cross-origin static", { url: "https://cdn.test/_next/static/a.js", mode: "no-cors" }],
    ["api", { url: `${ORIGIN}/API/x` }],
    ["admin", { url: `${ORIGIN}/admin` }],
    ["admin login", { url: `${ORIGIN}/admin/login` }],
    ["adminx", { url: `${ORIGIN}/adminx` }],
    ["embed", { url: `${ORIGIN}/embed/cluster/${ID}` }],
    ["vercel insights", { url: `${ORIGIN}/_vercel/insights/script.js`, mode: "no-cors" }],
    ["next image", { url: `${ORIGIN}/_next/image?url=%2Fa.png&w=64&q=75`, mode: "no-cors" }],
    ["sw.js itself", { url: `${ORIGIN}/sw.js`, mode: "same-origin" }],
    ["Range", { url: `${ORIGIN}/_next/static/media/a.woff2`, mode: "no-cors", hasRange: true }],
    ["only-if-cached + cors", { cache: "only-if-cached", mode: "cors", url: `${ORIGIN}/_next/static/a.js` }],
    ["rsc fetch (cors)", { url: `${ORIGIN}/cluster/${ID}?_rsc=1`, mode: "cors" }],
    ["font from non-static path", { url: `${ORIGIN}/fonts/a.woff2`, mode: "cors" }],
    ["unparseable url", { url: "not a url" }],
  ])("bypass: %s", (_name, over) => {
    expect(classifyRequest(req(over), ORIGIN)).toBe("bypass");
  });

  it("classifies hashed static assets (query kept) as static", () => {
    expect(
      classifyRequest(
        req({ url: `${ORIGIN}/_next/static/chunks/a.js?dpl=x`, mode: "no-cors" }),
        ORIGIN,
      ),
    ).toBe("static");
    expect(
      classifyRequest(
        req({ url: `${ORIGIN}/_next/static/media/f.woff2`, mode: "cors" }),
        ORIGIN,
      ),
    ).toBe("static");
  });

  it("classifies a navigation as navigate", () => {
    expect(classifyRequest(req(), ORIGIN)).toBe("navigate");
    expect(classifyRequest(req({ url: `${ORIGIN}/cluster/${ID}?utm_source=x` }), ORIGIN)).toBe(
      "navigate",
    );
  });

  it("lets only-if-cached through in same-origin mode", () => {
    expect(
      classifyRequest(
        req({ cache: "only-if-cached", mode: "same-origin", url: `${ORIGIN}/_next/static/a.js` }),
        ORIGIN,
      ),
    ).toBe("static");
  });
});

describe("pageCacheKey", () => {
  it("normalises a cluster url: lower-cased id, no query, no hash", () => {
    const key = `${ORIGIN}/cluster/${ID}`;
    expect(pageCacheKey(`${ORIGIN}/cluster/${ID}`, ORIGIN)).toBe(key);
    expect(pageCacheKey(`${ORIGIN}/cluster/${ID_UPPER}`, ORIGIN)).toBe(key);
    expect(pageCacheKey(`${ORIGIN}/cluster/${ID}?utm_source=x&utm_medium=y`, ORIGIN)).toBe(key);
    expect(pageCacheKey(`${ORIGIN}/cluster/${ID}#yorumlar`, ORIGIN)).toBe(key);
    expect(pageCacheKey(`${ORIGIN}/cluster/${ID}/`, ORIGIN)).toBe(key);
  });

  it.each([
    `${ORIGIN}/`,
    `${ORIGIN}/offline`,
    `${ORIGIN}/cluster`,
    `${ORIGIN}/cluster/`,
    `${ORIGIN}/cluster/not-a-uuid`,
    `${ORIGIN}/cluster/${ID}/kart`,
    `${ORIGIN}/cluster/${ID}/opengraph-image`,
    `${ORIGIN}/cluster/${ID}x`,
    `${ORIGIN}/embed/cluster/${ID}`,
    `${ORIGIN}/xcluster/${ID}`,
    `https://evil.test/cluster/${ID}`,
    "nonsense",
    "",
  ])("is null for %s", (url) => {
    expect(pageCacheKey(url, ORIGIN)).toBeNull();
  });
});

describe("isCacheableResponse", () => {
  const staticRes = (over: Record<string, unknown> = {}, h: Record<string, string> = {}) =>
    res(
      { url: `${ORIGIN}/_next/static/chunks/a.js?dpl=x`, ...over },
      { "content-type": "application/javascript", ...h },
    );
  const shellRes = (over: Record<string, unknown> = {}, h: Record<string, string> = {}) =>
    res({ url: `${ORIGIN}/offline`, ...over }, h);

  it("accepts the happy path for each target", () => {
    expect(isCacheableResponse(staticRes(), ORIGIN, "static")).toBe(true);
    expect(isCacheableResponse(res(), ORIGIN, "page")).toBe(true);
    expect(isCacheableResponse(shellRes(), ORIGIN, "shell")).toBe(true);
  });

  it("rejects no-store for static but tolerates it (and private) for page and shell", () => {
    const h = { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" };
    expect(isCacheableResponse(staticRes({}, h), ORIGIN, "static")).toBe(false);
    expect(isCacheableResponse(staticRes({}, { "cache-control": "NO-STORE" }), ORIGIN, "static")).toBe(false);
    expect(isCacheableResponse(res({}, h), ORIGIN, "page")).toBe(true);
    expect(isCacheableResponse(shellRes({}, h), ORIGIN, "shell")).toBe(true);
    expect(
      isCacheableResponse(
        staticRes({}, { "cache-control": "public, max-age=31536000, immutable" }),
        ORIGIN,
        "static",
      ),
    ).toBe(true);
  });

  it.each(["static", "page", "shell"] as const)("%s: rejects set-cookie", (target) => {
    const r = target === "static" ? staticRes({}, { "set-cookie": "a=b" }) : target === "page" ? res({}, { "set-cookie": "a=b" }) : shellRes({}, { "set-cookie": "a=b" });
    expect(isCacheableResponse(r, ORIGIN, target)).toBe(false);
  });

  it.each([
    ["404", { status: 404 }],
    ["206", { status: 206 }],
    ["500", { status: 500 }],
    ["opaque", { type: "opaque", status: 0 }],
    ["opaqueredirect", { type: "opaqueredirect", status: 0 }],
    ["cors", { type: "cors" }],
    ["redirected", { redirected: true }],
    ["empty url", { url: "" }],
  ])("rejects %s for every target", (_n, over) => {
    expect(isCacheableResponse(staticRes(over), ORIGIN, "static")).toBe(false);
    expect(isCacheableResponse(res(over), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(shellRes(over), ORIGIN, "shell")).toBe(false);
  });

  it("rejects a cross-origin url", () => {
    expect(isCacheableResponse(staticRes({ url: "https://cdn.test/_next/static/a.js" }), ORIGIN, "static")).toBe(false);
    expect(isCacheableResponse(res({ url: `https://evil.test/cluster/${ID}` }), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(shellRes({ url: "https://evil.test/offline" }), ORIGIN, "shell")).toBe(false);
  });

  it("rejects non-HTML pages and shells", () => {
    expect(isCacheableResponse(res({}, { "content-type": "application/json" }), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(shellRes({}, { "content-type": "text/plain" }), ORIGIN, "shell")).toBe(false);
    expect(
      isCacheableResponse(
        {
          status: 200,
          type: "basic",
          redirected: false,
          url: `${ORIGIN}/cluster/${ID}`,
          headers: headers(),
        },
        ORIGIN,
        "page",
      ),
    ).toBe(false);
  });

  it("rejects pages outside the allowlist", () => {
    expect(isCacheableResponse(res({ url: `${ORIGIN}/` }), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(res({ url: `${ORIGIN}/admin/x` }), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(res({ url: `${ORIGIN}/cluster/${ID}/kart` }), ORIGIN, "page")).toBe(false);
    expect(isCacheableResponse(res({ url: `${ORIGIN}/` }), ORIGIN, "shell")).toBe(false);
  });

  it("accepts a utm-tagged cluster url for page", () => {
    expect(isCacheableResponse(res({ url: `${ORIGIN}/cluster/${ID}?utm_source=x` }), ORIGIN, "page")).toBe(true);
  });

  it("rejects an unparseable res.url", () => {
    expect(isCacheableResponse(res({ url: "nope" }), ORIGIN, "page")).toBe(false);
  });
});

describe("planTrim", () => {
  it("returns the oldest overflow", () => {
    expect(planTrim(["a", "b", "c", "d", "e"], 3)).toEqual(["a", "b"]);
    expect(planTrim(["a", "b", "c"], 3)).toEqual([]);
    expect(planTrim(["a"], 3)).toEqual([]);
    expect(planTrim([], 3)).toEqual([]);
    expect(planTrim(["a", "b"], 0)).toEqual(["a", "b"]);
  });

  it("never deletes anything on a nonsensical max", () => {
    expect(planTrim(["a", "b"], -1)).toEqual([]);
    expect(planTrim(["a", "b"], Number.NaN)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const keys = ["a", "b", "c"];
    planTrim(keys, 1);
    expect(keys).toEqual(["a", "b", "c"]);
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const maxAge = 14 * DAY;

  it("treats a null, empty or unparseable stamp as expired", () => {
    expect(isExpired(null, now, maxAge)).toBe(true);
    expect(isExpired("", now, maxAge)).toBe(true);
    expect(isExpired("not-a-date", now, maxAge)).toBe(true);
    expect(isExpired("2026-13-45T99:99:99Z", now, maxAge)).toBe(true);
  });

  it("is fresh up to and including exactly 14 days, expired one ms later", () => {
    expect(isExpired(new Date(now).toISOString(), now, maxAge)).toBe(false);
    expect(isExpired(new Date(now - maxAge).toISOString(), now, maxAge)).toBe(false);
    expect(isExpired(new Date(now - maxAge - 1).toISOString(), now, maxAge)).toBe(true);
    expect(isExpired(new Date(now - 15 * DAY).toISOString(), now, maxAge)).toBe(true);
    expect(isExpired(new Date(now - 13 * DAY).toISOString(), now, maxAge)).toBe(false);
  });

  it("treats a stamp slightly in the future (clock skew) as fresh", () => {
    expect(isExpired(new Date(now + 1000).toISOString(), now, maxAge)).toBe(false);
  });
});

describe("cachesToDelete", () => {
  it("deletes only tayf- caches that are not kept", () => {
    const keep = Object.values(CACHE_NAMES);
    expect(
      cachesToDelete(
        [
          "tayf-static-v0",
          "tayf-pages-v0",
          "tayf-shell-v0",
          CACHE_NAMES.static,
          CACHE_NAMES.pages,
          CACHE_NAMES.shell,
          "tayf-saved-v1",
          "other-lib",
          "workbox-precache",
          "tayf",
        ],
        keep,
      ),
    ).toEqual(["tayf-static-v0", "tayf-pages-v0", "tayf-shell-v0"]);
  });

  it("keeps tayf-saved-v1 when it is in keep", () => {
    expect(cachesToDelete(["tayf-saved-v1"], Object.values(CACHE_NAMES))).toEqual([]);
  });

  it("with an empty keep list deletes every tayf- cache (kill mode semantics)", () => {
    expect(cachesToDelete(["tayf-saved-v1", "tayf-x", "keep-me"], [])).toEqual([
      "tayf-saved-v1",
      "tayf-x",
    ]);
  });
});

describe("isStoryHtml", () => {
  it.each([
    ["property first", '<meta property="og:type" content="article"/>'],
    ["content first", '<meta content="article" property="og:type">'],
    ["single quotes", "<meta content='article' property='og:type'/>"],
    ["upper case value", '<meta property="og:type" content="ARTICLE"/>'],
    ["padded value", '<meta property="og:type" content=" article "/>'],
    [
      "among other tags (streamed metadata in the body)",
      '<head><title>T</title></head><body><div hidden><meta property="og:title" content="T"/><meta property="og:type" content="article"/><meta property="article:author" content="x"/></div></body>',
    ],
  ])("accepts a story: %s", (_n, html) => {
    expect(isStoryHtml(html)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["no meta at all", "<html><body>Sayfa bulunamadı</body></html>"],
    ["the soft-404 / error shell (inherits og:type website)", '<meta property="og:type" content="website"/>'],
    ["an empty value", '<meta property="og:type" content=""/>'],
    ["a longer value", '<meta property="og:type" content="articles"/>'],
    ["another property carrying the word", '<meta property="og:title" content="article"/>'],
    ["article:* properties alone", '<meta property="article:author" content="article"/>'],
    ["escaped markup inside text", '<p>&lt;meta property="og:type" content="article"&gt;</p>'],
    ["a meta tag without content", '<meta property="og:type"/>'],
    ["og:type given only as a text node", "<p>og:type article</p>"],
  ])("rejects: %s", (_n, html) => {
    expect(isStoryHtml(html)).toBe(false);
  });
});

describe("extractTitle", () => {
  it("prefers og:title over <title>", () => {
    const html =
      '<head><title>Eski — Tayf</title><meta property="og:title" content="Yeni başlık"/></head>';
    expect(extractTitle(html)).toBe("Yeni başlık");
  });

  it("also reads og:title with content before property and single quotes", () => {
    expect(extractTitle("<meta content='Önce içerik' property='og:title'>")).toBe("Önce içerik");
    expect(extractTitle('<meta content="Ters" property="og:title">')).toBe("Ters");
  });

  it("ignores other meta tags", () => {
    const html =
      '<meta property="og:description" content="Açıklama"><meta name="twitter:title" content="X"><title>Gerçek — Tayf</title>';
    expect(extractTitle(html)).toBe("Gerçek");
  });

  it("uses the LAST <title> (streamed metadata lands in the body)", () => {
    const html =
      "<head><title>Tayf — Türkiye Haber Analizi</title></head><body>x<title>Asıl başlık — Tayf</title></body>";
    expect(extractTitle(html)).toBe("Asıl başlık");
  });

  it("strips a trailing ' — Tayf' suffix from og:title and <title> only at the end", () => {
    expect(extractTitle('<meta property="og:title" content="Bir haber — Tayf">')).toBe("Bir haber");
    expect(extractTitle("<title>Tayf — Haber Analizi</title>")).toBe("Tayf — Haber Analizi");
    expect(extractTitle("<title>Tayf</title>")).toBe("Tayf");
  });

  it("decodes named, hex and decimal entities in a single pass", () => {
    expect(extractTitle("<title>A &amp; B &lt;c&gt; &quot;d&quot; &#x27;e&#39;f</title>")).toBe(
      "A & B <c> \"d\" 'e'f",
    );
    expect(extractTitle("<title>&#350;ehir &#x15F; &#128512;</title>")).toBe("Şehir ş 😀");
    // &amp;lt; must decode to the literal text "&lt;", never to "<"
    expect(extractTitle("<title>&amp;lt;</title>")).toBe("&lt;");
  });

  it("leaves invalid numeric entities from throwing", () => {
    expect(() => extractTitle("<title>&#99999999999; &#xD800; &#0;</title>")).not.toThrow();
  });

  it("trims whitespace and caps at 200 characters", () => {
    expect(extractTitle("<title>   boşluklu \n </title>")).toBe("boşluklu");
    const long = "a".repeat(500);
    expect(extractTitle(`<title>${long}</title>`)).toBe("a".repeat(200));
  });

  it("never splits a surrogate pair when capping", () => {
    const t = extractTitle(`<title>${"a".repeat(199)}😀tail</title>`);
    expect(t).toBe("a".repeat(199));
    expect(() => encodeURIComponent(t)).not.toThrow();
  });

  it("falls back when there is no usable title", () => {
    expect(extractTitle("")).toBe("Kaydedilen hikâye");
    expect(extractTitle("<html><body>x</body></html>")).toBe("Kaydedilen hikâye");
    expect(extractTitle("<title>   </title>")).toBe("Kaydedilen hikâye");
    expect(extractTitle("<title> — Tayf</title>")).toBe("Kaydedilen hikâye");
    expect(extractTitle('<meta property="og:title" content="">')).toBe("Kaydedilen hikâye");
  });

  it("falls back to <title> when og:title is empty", () => {
    expect(
      extractTitle('<meta property="og:title" content="  "><title>Başlık — Tayf</title>'),
    ).toBe("Başlık");
  });
});

describe("extractShellAssets", () => {
  const html = [
    '<link rel="stylesheet" href="/_next/static/css/a.css?dpl=dpl_1"/>',
    '<script src="/_next/static/chunks/main.js?a=1&amp;b=2" async></script>',
    '<script src="/_next/static/chunks/main.js?a=1&amp;b=2" async></script>', // duplicate
    '<link rel="preload" href="/_next/static/media/f.woff2#frag" as="font"/>', // fragment urls are not matched
    '<link rel="preload" href="/_next/static/media/g.woff2" as="font"/>',
    '<script src="https://cdn.test/_next/static/chunks/x.js"></script>', // cross-origin
    '<script src="//cdn.test/_next/static/chunks/y.js"></script>', // protocol-relative
    '<img src="/logo.png"/>',
    '<link href="/_next/static/css/b.css"/>',
  ].join("\n");

  it("returns absolute same-origin urls in order, deduped, query kept, &amp; decoded, fragment urls skipped", () => {
    expect(extractShellAssets(html, ORIGIN, 60)).toEqual([
      `${ORIGIN}/_next/static/css/a.css?dpl=dpl_1`,
      `${ORIGIN}/_next/static/chunks/main.js?a=1&b=2`,
      `${ORIGIN}/_next/static/media/g.woff2`,
      `${ORIGIN}/_next/static/css/b.css`,
    ]);
  });

  it("caps at max", () => {
    expect(extractShellAssets(html, ORIGIN, 2)).toHaveLength(2);
    expect(extractShellAssets(html, ORIGIN, 0)).toEqual([]);
  });

  it("returns [] for empty and asset-free html", () => {
    expect(extractShellAssets("", ORIGIN, 10)).toEqual([]);
    expect(extractShellAssets("<p>hi</p>", ORIGIN, 10)).toEqual([]);
  });

  it("never lets a traversal path escape /_next/static/", () => {
    const out = extractShellAssets(
      '<script src="/_next/static/../../admin/secret.js"></script>',
      ORIGIN,
      10,
    );
    expect(out).toEqual([]);
  });
});

describe("parseMessage", () => {
  it("accepts pin and unpin with a valid id (normalised to lower case)", () => {
    expect(parseMessage({ type: "tayf:pin", id: ID }, 500)).toEqual({ type: "tayf:pin", id: ID });
    expect(parseMessage({ type: "tayf:unpin", id: ID_UPPER }, 500)).toEqual({
      type: "tayf:unpin",
      id: ID,
    });
  });

  it.each([
    null,
    undefined,
    "tayf:pin",
    42,
    true,
    [],
    {},
    { type: "tayf:pin" },
    { type: "tayf:pin", id: 7 },
    { type: "tayf:pin", id: "../admin" },
    { type: "tayf:pin", id: `${ID}/../../admin` },
    { type: "tayf:pin", id: "/cluster/" + ID },
    { type: "tayf:unpin", id: "" },
    { type: "tayf:other", id: ID },
    { type: "tayf:sync" },
    { type: "tayf:sync", ids: "nope" },
    { type: "tayf:sync", ids: { length: 1 } },
    { id: ID },
  ])("rejects garbage %#", (data) => {
    expect(parseMessage(data, 500)).toBeNull();
  });

  it("filters, dedupes and lower-cases sync ids", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(
      parseMessage(
        { type: "tayf:sync", ids: [ID, "../admin", 3, null, ID_UPPER, other, "", ID] },
        500,
      ),
    ).toEqual({ type: "tayf:sync", ids: [ID, other] });
  });

  it("keeps the LAST maxIds of a sync", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    expect(parseMessage({ type: "tayf:sync", ids }, 3)).toEqual({
      type: "tayf:sync",
      ids: ids.slice(-3),
    });
    expect(parseMessage({ type: "tayf:sync", ids }, 0)).toEqual({ type: "tayf:sync", ids: [] });
  });

  it("accepts an empty sync (unpin everything)", () => {
    expect(parseMessage({ type: "tayf:sync", ids: [] }, 500)).toEqual({ type: "tayf:sync", ids: [] });
  });

  it("does not throw on a hostile getter", () => {
    const hostile = {
      get type(): string {
        throw new Error("boom");
      },
    };
    expect(() => parseMessage(hostile, 500)).not.toThrow();
    expect(parseMessage(hostile, 500)).toBeNull();
  });
});

describe("buildStoredHeaders", () => {
  const src = headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=()",
    "content-encoding": "br",
    "content-length": "1234",
    vary: "RSC, Next-Router-State-Tree",
    "set-cookie": "a=b",
    "cache-control": "private, no-store",
    "strict-transport-security": "max-age=1",
  });
  const NOW = "2026-10-23T12:00:00.000Z";

  it("keeps CSP and the other copied headers, adds cached-at", () => {
    const h = buildStoredHeaders(src, NOW);
    expect(h["content-security-policy"]).toBe("default-src 'self'");
    expect(h["content-type"]).toBe("text/html; charset=utf-8");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toBe("camera=()");
    expect(h[HEADER_CACHED_AT]).toBe(NOW);
    expect(HEADER_TITLE in h).toBe(false);
  });

  it("copies exactly the COPIED_PAGE_HEADERS and nothing else (plus the tayf stamps)", () => {
    const h = buildStoredHeaders(src, NOW, "T");
    expect(Object.keys(h).sort()).toEqual([...COPIED_PAGE_HEADERS, HEADER_CACHED_AT, HEADER_TITLE].sort());
  });

  it("never copies content-encoding, content-length, vary, set-cookie, cache-control or HSTS", () => {
    const h = buildStoredHeaders(src, NOW, "T");
    for (const banned of ["content-encoding", "content-length", "vary", "set-cookie", "cache-control", "strict-transport-security"]) {
      expect(banned in h, banned).toBe(false);
    }
  });

  it("skips copied headers the source does not have", () => {
    const h = buildStoredHeaders(headers({ "content-type": "text/html" }), NOW);
    expect(Object.keys(h).sort()).toEqual(["content-type", HEADER_CACHED_AT].sort());
  });

  it("URI-encodes Turkish and special-character titles", () => {
    const title = "Şehirde 100% “özel” gelişme & daha fazlası";
    const h = buildStoredHeaders(src, NOW, title);
    expect(h[HEADER_TITLE]).toBe(encodeURIComponent(title));
    expect(decodeURIComponent(h[HEADER_TITLE]!)).toBe(title);
    // header values must be ByteString-safe
    expect(/^[\x20-\x7e]*$/.test(h[HEADER_TITLE]!)).toBe(true);
  });

  it("omits the title header rather than throwing on a lone surrogate", () => {
    expect(() => buildStoredHeaders(src, NOW, "bad\ud800")).not.toThrow();
    expect(HEADER_TITLE in buildStoredHeaders(src, NOW, "bad\ud800")).toBe(false);
  });
});
