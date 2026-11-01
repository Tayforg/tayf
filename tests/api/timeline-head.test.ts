import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// GET /api/timeline/head -- the CDN-cached "what is the newest" probe behind
// the /timeline "N yeni küme · Yenile" pill.
//
// The route reuses getRecentClusters() (the SAME "use cache" entry that renders
// the page), so polling adds no Supabase read of its own and the head can never
// show a cluster the refreshed page cannot. The module is mocked here, which is
// also why public-reader-cap needs no entry: the route makes no Supabase call.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const query = vi.hoisted(() => ({
  getRecentClusters: vi.fn(),
}));

vi.mock("@/lib/clusters/timeline-query", () => query);

const HEAD_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=60";

function mkRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title_tr: `Gizli başlık ${i}`,
    title_tr_neutral: i % 2 === 0 ? `Gizli nötr ${i}` : null,
    article_count: 3 + i,
    first_published: new Date(
      Date.UTC(2026, 8, 18, 10, 0, 0) - i * 60_000,
    ).toISOString(),
  }));
}

let ipCounter = 0;
/** A fresh client IP per call so no test inherits another's rate-limit bucket. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function headRequest(search = "", ip = freshIp()): Request {
  return new Request(`http://example.com/api/timeline/head${search}`, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  query.getRecentClusters.mockReset();
  query.getRecentClusters.mockResolvedValue({ rows: mkRows(200), total: 234 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/timeline/head", () => {
  it("answers 200 with {clusters:[{id, first_published}]} and nothing else", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const text = await res.text();
    const body = JSON.parse(text) as { clusters: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(["clusters"]);
    expect(body.clusters.length).toBeGreaterThan(0);
    for (const c of body.clusters) {
      expect(Object.keys(c).sort()).toEqual(["first_published", "id"]);
    }
    // Titles and counts must not leak through this public, CDN-cached probe.
    expect(text).not.toContain("Gizli");
    expect(text).not.toContain("article_count");
    expect(text).not.toContain("total");
  });

  it("returns at most 50 rows, newest first (the page's own order)", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
    const body = (await (await GET(headRequest())).json()) as {
      clusters: Array<{ id: string; first_published: string }>;
    };
    expect(body.clusters).toHaveLength(50);
    expect(body.clusters.map((c) => c.id)).toEqual(
      mkRows(50).map((r) => r.id),
    );
    const times = body.clusters.map((c) => Date.parse(c.first_published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("returns every row when the page has fewer than 50", async () => {
    query.getRecentClusters.mockResolvedValue({ rows: mkRows(3), total: 3 });
    const { GET } = await import("@/app/api/timeline/head/route");
    const body = (await (await GET(headRequest())).json()) as { clusters: unknown[] };
    expect(body.clusters).toHaveLength(3);
  });

  it("returns an empty list (200, not 503) when nothing was minted", async () => {
    query.getRecentClusters.mockResolvedValue({ rows: [], total: 0 });
    const { GET } = await import("@/app/api/timeline/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clusters: [] });
  });

  it("sets the exact CDN cache header on a 200", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
    const res = await GET(headRequest());
    expect(res.headers.get("Cache-Control")).toBe(HEAD_CACHE_CONTROL);
  });

  it("a null read is a 503 with no-store and Retry-After 120, never a cached empty list", async () => {
    query.getRecentClusters.mockResolvedValue(null);
    const { GET } = await import("@/app/api/timeline/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("120");
    const body = (await res.json()) as { error: unknown; clusters?: unknown };
    expect(typeof body.error).toBe("string");
    expect(body.clusters).toBeUndefined();
  });

  it("a thrown read is a generic 500, not a leak of the error message", async () => {
    query.getRecentClusters.mockRejectedValue(new Error("secret table name"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/timeline/head/route");
    const res = await GET(headRequest());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("returns 429 via apiTooManyRequests once one client exhausts its bucket", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
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
    expect(query.getRecentClusters).toHaveBeenCalledTimes(30);
  });

  it("one client's exhausted bucket does not throttle another client", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
    const greedy = freshIp();
    for (let i = 0; i < 31; i++) await GET(headRequest("", greedy));
    const res = await GET(headRequest("", freshIp()));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/timeline/head -- cache key", () => {
  it("?cb=123 gives the same body and getRecentClusters() is called with no args", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
    const plain = await (await GET(headRequest())).json();
    const busted = await (await GET(headRequest("?cb=123"))).json();
    const busted2 = await (await GET(headRequest("?cb=abc&x=%00&cb=2"))).json();
    expect(busted).toEqual(plain);
    expect(busted2).toEqual(plain);

    expect(query.getRecentClusters).toHaveBeenCalledTimes(3);
    for (const call of query.getRecentClusters.mock.calls) {
      expect(call).toEqual([]);
    }
  });

  it("never reads request.url (a cache-buster cannot reach the cache key)", async () => {
    const { GET } = await import("@/app/api/timeline/head/route");
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

describe("timeline-head route source", () => {
  const src = readFileSync(
    resolve(ROOT, "src/app/api/timeline/head/route.ts"),
    "utf8",
  );
  // Comments blanked so prose cannot satisfy or trip a check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

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

  it("makes no Supabase call of its own", () => {
    expect(code).not.toMatch(/createServerClient|createReaderClient|createClient/);
  });

  it("is wrapped in withApiErrors and answers throttling through apiTooManyRequests", () => {
    expect(code).toMatch(/withApiErrors\s*\(/);
    expect(code).toMatch(/apiTooManyRequests\s*\(/);
  });
});
