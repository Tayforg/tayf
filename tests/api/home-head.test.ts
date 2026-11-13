import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { blankComments } from "../_helpers/blank-comments";

// ---------------------------------------------------------------------------
// GET /api/home/head -- the CDN-cached "what is in the Son Dakika strip" probe
// behind the home page's "N yeni son dakika haberi · Yenile" pill (h170-roadmap-2).
//
// The route reads getPoliticsClusters() -- the SAME cached entry that renders the
// strip -- and derives the strip with the helper HomeFeed uses (splitHomeFeed), so
// polling adds no database read of its own and the head can never name a story the
// strip does not hold. politics-query is mocked except for that pure helper, which
// is also why public-reader-cap needs no entry: the route makes no Supabase call.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const query = vi.hoisted(() => ({
  getPoliticsClusters: vi.fn(),
}));

vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return {
    ...actual,
    getPoliticsClusters: (...args: unknown[]) => query.getPoliticsClusters(...args),
  };
});

import { splitHomeFeed, type PoliticsClustersResult } from "@/lib/clusters/politics-query";

const HEAD_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=60";
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);

function mkBundle(id: string, minutesAgo: number) {
  return {
    cluster: {
      id,
      title_tr: `Gizli başlık ${id}`,
      title_tr_neutral: `Gizli nötr ${id}`,
      article_count: 3,
      first_published: new Date(T0 - minutesAgo * 60_000).toISOString(),
      updated_at: new Date(T0).toISOString(),
    },
    articles: [],
    sources: [],
  };
}

/** A feed whose strip holds `strip` stories (newest first) and whose ranked list holds `ranked` more. */
function mkFeed(strip: number, ranked = 4): PoliticsClustersResult {
  return {
    breakingBundles: Array.from({ length: strip }, (_, i) => mkBundle(`s${i}`, i * 5)),
    bundles: Array.from({ length: ranked }, (_, i) => mkBundle(`r${i}`, 200 + i)),
    prefilterCount: 100,
  } as unknown as PoliticsClustersResult;
}

let ipCounter = 0;
/** A fresh client IP per call so no test inherits another's rate-limit bucket. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function headRequest(search = "", ip = freshIp()): Request {
  return new Request(`http://example.com/api/home/head${search}`, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  query.getPoliticsClusters.mockReset();
  query.getPoliticsClusters.mockResolvedValue(mkFeed(4));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/home/head", () => {
  it("answers 200 with {breaking:[{id, first_published}]} and nothing else", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const text = await res.text();
    const body = JSON.parse(text) as { breaking: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(["breaking"]);
    expect(body.breaking.length).toBeGreaterThan(0);
    for (const c of body.breaking) {
      expect(Object.keys(c).sort()).toEqual(["first_published", "id"]);
    }
    // Ids and dates only: no title, count or ranked story leaks through this public, CDN-cached probe.
    expect(text).not.toContain("Gizli");
    expect(text).not.toContain("article_count");
    expect(text).not.toContain("r0");
  });

  it("returns at most 6 rows, newest first (the strip's own order)", async () => {
    query.getPoliticsClusters.mockResolvedValue(mkFeed(9));
    const { GET } = await import("@/app/api/home/head/route");
    const body = (await (await GET(headRequest())).json()) as {
      breaking: Array<{ id: string; first_published: string }>;
    };
    expect(body.breaking).toHaveLength(6);
    expect(body.breaking.map((c) => c.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    const times = body.breaking.map((c) => Date.parse(c.first_published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("returns every row when the strip holds fewer than 6", async () => {
    query.getPoliticsClusters.mockResolvedValue(mkFeed(2));
    const { GET } = await import("@/app/api/home/head/route");
    const body = (await (await GET(headRequest())).json()) as { breaking: unknown[] };
    expect(body.breaking).toHaveLength(2);
  });

  it("an empty strip is a 200 with an empty list, not a 503", async () => {
    query.getPoliticsClusters.mockResolvedValue(mkFeed(0));
    const { GET } = await import("@/app/api/home/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ breaking: [] });
  });

  it("is exactly the strip HomeFeed derives: a story that is also ranked stays in the head", async () => {
    const feed = mkFeed(3);
    // s1 scores into the ranked list too: HomeFeed's dedupe drops it from the list, never from the strip.
    (feed.bundles as unknown[]).push(feed.breakingBundles[1]);
    query.getPoliticsClusters.mockResolvedValue(feed);
    const { GET } = await import("@/app/api/home/head/route");
    const body = (await (await GET(headRequest())).json()) as {
      breaking: Array<{ id: string; first_published: string }>;
    };
    const strip = splitHomeFeed(feed).filteredBreaking;
    expect(body.breaking).toEqual(
      strip.map((b) => ({ id: b.cluster.id, first_published: b.cluster.first_published })),
    );
    expect(body.breaking.map((c) => c.id)).toContain("s1");
  });

  it("sets the exact CDN cache header on a 200 (the same as /api/timeline/head)", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const res = await GET(headRequest());
    expect(res.headers.get("Cache-Control")).toBe(HEAD_CACHE_CONTROL);
  });

  it("a null read is a 503 with no-store and Retry-After 120, never a cached empty list", async () => {
    query.getPoliticsClusters.mockResolvedValue(null);
    const { GET } = await import("@/app/api/home/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("120");
    const body = (await res.json()) as { error: unknown; breaking?: unknown };
    expect(typeof body.error).toBe("string");
    expect(body.breaking).toBeUndefined();
  });

  it("a failed read (the cached read throws after its own retry) is the same 503, without the error message", async () => {
    query.getPoliticsClusters.mockRejectedValue(new Error("secret table name"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("@/app/api/home/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("returns 429 via apiTooManyRequests once one client exhausts its bucket of 30", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const ip = freshIp();
    for (let i = 0; i < 30; i++) {
      const res = await GET(headRequest("", ip));
      expect(res.status).toBe(200);
    }
    const res = await GET(headRequest("", ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      error: string;
      details: { retryAfterMs: number };
    };
    expect(typeof body.error).toBe("string");
    expect(typeof body.details.retryAfterMs).toBe("number");
    // The throttled call must not have touched the (cached) read.
    expect(query.getPoliticsClusters).toHaveBeenCalledTimes(30);
  });

  it("one client's exhausted bucket does not throttle another client", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const greedy = freshIp();
    for (let i = 0; i < 31; i++) await GET(headRequest("", greedy));
    const res = await GET(headRequest("", freshIp()));
    expect(res.status).toBe(200);
  });

  it("has a limiter of its own: exhausting /api/home/head leaves /api/timeline/head untouched", async () => {
    vi.doMock("@/lib/clusters/timeline-query", () => ({
      getRecentClusters: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    }));
    try {
      const home = await import("@/app/api/home/head/route");
      const timeline = await import("@/app/api/timeline/head/route");
      const ip = freshIp();
      for (let i = 0; i < 31; i++) await home.GET(headRequest("", ip));
      expect((await home.GET(headRequest("", ip))).status).toBe(429);
      const res = await timeline.GET(
        new Request("http://example.com/api/timeline/head", { headers: { "x-forwarded-for": ip } }),
      );
      expect(res.status).toBe(200);
    } finally {
      vi.doUnmock("@/lib/clusters/timeline-query");
    }
  });
});

describe("GET /api/home/head -- cache key", () => {
  it("?cb=123 gives the same body and getPoliticsClusters() is called with no args", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const plain = await (await GET(headRequest())).json();
    const busted = await (await GET(headRequest("?cb=123"))).json();
    const busted2 = await (await GET(headRequest("?cb=abc&x=%00&cb=2"))).json();
    expect(busted).toEqual(plain);
    expect(busted2).toEqual(plain);

    expect(query.getPoliticsClusters).toHaveBeenCalledTimes(3);
    for (const call of query.getPoliticsClusters.mock.calls) {
      expect(call).toEqual([]);
    }
  });

  it("never reads request.url (a cache-buster cannot reach the cache key)", async () => {
    const { GET } = await import("@/app/api/home/head/route");
    const req = headRequest("?cb=999");
    Object.defineProperty(req, "url", {
      get() {
        throw new Error("the handler must not read request.url");
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});

describe("unsupported methods on /api/home/head", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s is a JSON 405 with Allow: GET, HEAD, OPTIONS, no-store and no CORS",
    async (method) => {
      const mod = await import("@/app/api/home/head/route");
      const handler = mod[method] as ((req?: Request) => Promise<Response> | Response) | undefined;
      expect(handler, `${method} is not exported`).toBeTypeOf("function");
      const res = await handler!(
        new Request("http://example.com/api/home/head", { method, headers: { "x-forwarded-for": freshIp() } }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await res.text()).toBe('{"error":"Method not allowed"}');
    },
  );

  it("OPTIONS is a bodyless 204 advertising GET, HEAD, OPTIONS", async () => {
    const { OPTIONS } = await import("@/app/api/home/head/route");
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("a refusal never reads the cluster cache nor spends a rate-limit token", async () => {
    const { POST, GET } = await import("@/app/api/home/head/route");
    const ip = freshIp();
    // 30 is the bucket capacity: 100 refusals from one IP must leave it untouched.
    for (let i = 0; i < 100; i++) {
      const res = await POST(
        new Request("http://example.com/api/home/head", { method: "POST", headers: { "x-forwarded-for": ip } }),
      );
      expect(res.status).toBe(405);
    }
    expect(query.getPoliticsClusters).not.toHaveBeenCalled();
    const ok = await GET(headRequest("", ip));
    expect(ok.status).toBe(200);
  });
});

describe("home-head route source", () => {
  const src = readFileSync(resolve(ROOT, "src/app/api/home/head/route.ts"), "utf8");
  const timelineSrc = readFileSync(resolve(ROOT, "src/app/api/timeline/head/route.ts"), "utf8");
  // Comments blanked (by a character scan, no regex over the source) so prose cannot satisfy or trip a check.
  const code = blankComments(src);
  const timelineCode = blankComments(timelineSrc);

  /** The `{ ... }` of `const HEAD_HEADERS = {` with whitespace runs squeezed, or null. */
  function headHeaders(text: string): string | null {
    const at = text.indexOf("const HEAD_HEADERS = {");
    if (at === -1) return null;
    const open = text.indexOf("{", at);
    const close = text.indexOf("}", open);
    if (close === -1) return null;
    return text.slice(open, close + 1).split(/\s+/).join(" ");
  }

  it("never reads the URL or the query string", () => {
    expect(code).not.toMatch(/\.url\b/);
    expect(code).not.toMatch(/new\s+URL\s*\(/);
    expect(code).not.toMatch(/searchParams/);
    expect(code).not.toMatch(/nextUrl/);
  });

  it("exports no route-segment config (cacheComponents forbids it)", () => {
    expect(code).not.toMatch(
      /export\s+const\s+(revalidate|dynamic|runtime|fetchCache|dynamicParams|preferredRegion|maxDuration)\b/,
    );
  });

  it("makes no Supabase call of its own and reads nothing but getPoliticsClusters()", () => {
    expect(code).not.toMatch(/createServerClient|createReaderClient|createClient/);
    expect(code).not.toMatch(/\.from\s*\(|\.rpc\s*\(/);
    expect(code).not.toMatch(/getRecentClusters|searchClusters|getTopicClusters|getBlindspots/);
    expect(code.match(/getPoliticsClusters\s*\(/g) ?? []).toHaveLength(1);
  });

  it("derives the strip with the helper HomeFeed uses, never with a filter of its own", () => {
    expect(code).toMatch(/splitHomeFeed\s*\(/);
    expect(code).not.toMatch(/breakingBundles\s*\.\s*(filter|slice|sort)/);
  });

  it("is wrapped in withApiErrors and answers throttling through apiTooManyRequests", () => {
    expect(code).toMatch(/withApiErrors\s*\(/);
    expect(code).toMatch(/apiTooManyRequests\s*\(/);
  });

  it("owns a limiter named home-head: 30 tokens, 0.5 a second", () => {
    expect(code).toMatch(
      /createRateLimiter\(\s*"home-head"\s*,\s*\{\s*capacity:\s*30,\s*refillPerSecond:\s*0\.5,?\s*\}\s*\)/,
    );
    expect(code.match(/createRateLimiter\s*\(/g) ?? []).toHaveLength(1);
  });

  it("uses the very HEAD_HEADERS of /api/timeline/head", () => {
    const mine = headHeaders(code);
    expect(mine).not.toBeNull();
    expect(mine).toBe(headHeaders(timelineCode));
    expect(mine).toContain("public, max-age=0, s-maxage=60, stale-while-revalidate=60");
  });

  it("the header-literal reader finds a block, and nothing in a file without one", () => {
    expect(headHeaders("const HEAD_HEADERS = {\n  a: 1,\n};")).toBe("{ a: 1, }");
    expect(headHeaders("const OTHER = {};")).toBeNull();
  });

  it("a failed read answers no-store with Retry-After 120", () => {
    expect(code).toMatch(/["']Cache-Control["']\s*:\s*["']no-store["']/);
    expect(code).toMatch(/["']Retry-After["']\s*:\s*["']120["']/);
  });
});
