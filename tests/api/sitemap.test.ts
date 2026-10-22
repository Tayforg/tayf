import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// /sitemap.xml (index) + /sitemaps/[file] (leaves) — route-level coverage.
// Unit coverage for the XML shape and query filters lives in
// src/lib/seo/sitemaps.test.ts; this file exercises the two Next.js route
// handlers end to end (status codes, content-type, cache headers).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// connection() throws outside a request scope in vitest; stub it so we can
// assert the index handler opts out of prerendering.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: vi.fn(async () => {}) };
});

const fixture = vi.hoisted(() => ({
  clusters: [] as Array<Record<string, unknown>>,
  sources: [] as Array<Record<string, unknown>>,
  clustersError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        if (fixture.clustersError) {
          return { data: null, error: fixture.clustersError };
        }
        let rows = fixture.clusters.filter((r) =>
          state.eq.every(({ col, val }) => r[col] === val),
        );
        if (state.range) {
          rows = rows.slice(state.range.from, state.range.to + 1);
        }
        return { data: rows, error: null };
      },
      sources: (state) => {
        const rows = fixture.sources.filter((r) =>
          state.eq.every(({ col, val }) => r[col] === val),
        );
        return { data: rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife } from "next/cache";
import { connection } from "next/server";

import { GET as getSitemapIndex } from "@/app/sitemap.xml/route";
import { GET as getSitemapFile } from "@/app/sitemaps/[file]/route";

const ORIGINAL_ENV = { ...process.env };

function callFile(file: string) {
  return getSitemapFile(new Request(`https://tayf.test/sitemaps/${file}`), {
    params: Promise.resolve({ file }),
  });
}

beforeEach(() => {
  vi.mocked(connection).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
  fixture.clusters = [];
  fixture.sources = [];
  fixture.clustersError = null;
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("GET /sitemap.xml", () => {
  it("returns a sitemap index listing the leaf sitemaps", async () => {
    const res = await getSitemapIndex();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");

    const body = await res.text();
    expect(body).toContain("<sitemapindex");
    expect(body).toContain("https://tayf.test/sitemaps/news.xml");
    expect(body).toContain("https://tayf.test/sitemaps/static.xml");
    expect(body).toContain("https://tayf.test/sitemaps/sources.xml");
  });

  it("runs per request: awaits connection() and picks up a new UTC month the hour it starts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:30:00Z"));

    const res = await getSitemapIndex();

    expect(connection).toHaveBeenCalledTimes(1);
    const body = await res.text();
    expect(body).toContain("https://tayf.test/sitemaps/clusters-2026-11.xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
  });

  it("calls connection() before touching the cache layer", async () => {
    const order: string[] = [];
    vi.mocked(connection).mockImplementationOnce(async () => {
      order.push("connection");
    });
    vi.mocked(cacheLife).mockImplementationOnce(() => {
      order.push("cacheLife");
    });

    await getSitemapIndex();

    expect(order[0]).toBe("connection");
  });
});

describe("GET /sitemaps/[file] cache headers", () => {
  const SHORT = "public, s-maxage=3600, stale-while-revalidate=86400";
  const LONG = "public, s-maxage=86400, stale-while-revalidate=604800";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  });

  it("a CLOSED month (clusters-2026-09.xml) gets the long CDN cache", async () => {
    const res = await callFile("clusters-2026-09.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(LONG);
  });

  it("the CURRENT month (clusters-2026-10.xml) keeps the short cache", async () => {
    const res = await callFile("clusters-2026-10.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(SHORT);
  });

  it("a FUTURE month never gets the long cache", async () => {
    const res = await callFile("clusters-2026-11.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(SHORT);
  });

  it("static.xml and sources.xml keep the default cache; news.xml keeps its own", async () => {
    expect((await callFile("static.xml")).headers.get("cache-control")).toBe(SHORT);
    expect((await callFile("sources.xml")).headers.get("cache-control")).toBe(SHORT);
    expect((await callFile("news.xml")).headers.get("cache-control")).toBe(
      "public, s-maxage=600, stale-while-revalidate=3600",
    );
  });

  it("flips a month to the long cache once the UTC month rolls over", async () => {
    vi.setSystemTime(new Date("2026-11-03T00:30:00Z"));
    const res = await callFile("clusters-2026-10.xml");
    expect(res.headers.get("cache-control")).toBe(LONG);
  });

  it("a 503 on a closed month is still no-store (a failure is never long-cached)", async () => {
    fixture.clustersError = { message: "boom" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callFile("clusters-2026-09.xml");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    errSpy.mockRestore();
  });
});

describe("GET /sitemaps/[file]", () => {
  it("news.xml → 200", async () => {
    fixture.clusters = [
      {
        id: "n1",
        is_archived: false,
        article_count: 3,
        title_tr: "Başlık",
        title_tr_neutral: "Başlık",
        first_published: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const res = await callFile("news.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("https://tayf.test/cluster/n1");
  });

  it("clusters-2026-09.xml → 200", async () => {
    fixture.clusters = [
      {
        id: "c1",
        is_archived: false,
        article_count: 5,
        updated_at: "2026-09-05T00:00:00.000Z",
      },
    ];
    const res = await callFile("clusters-2026-09.xml");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("https://tayf.test/cluster/c1");
  });

  it("sources.xml → 200", async () => {
    fixture.sources = [{ slug: "kaynak-a", active: true }];
    const res = await callFile("sources.xml");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("https://tayf.test/source/kaynak-a");
  });

  it("bogus.xml → 404", async () => {
    const res = await callFile("bogus.xml");
    expect(res.status).toBe(404);
  });

  it("a Supabase error → 503 no-store", async () => {
    fixture.clustersError = { message: "boom" };
    const res = await callFile("news.xml");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("archived clusters are absent from clusters-YYYY-MM.xml", async () => {
    fixture.clusters = [
      { id: "active-1", is_archived: false, article_count: 5, updated_at: "2026-09-05T00:00:00.000Z" },
      { id: "archived-1", is_archived: true, article_count: 5, updated_at: "2026-09-05T00:00:00.000Z" },
    ];
    const res = await callFile("clusters-2026-09.xml");
    const body = await res.text();
    expect(body).toContain("https://tayf.test/cluster/active-1");
    expect(body).not.toContain("https://tayf.test/cluster/archived-1");
  });

  // LEG-04 — no Google "image:image" extension, and no outlet CDN URL
  // (Tayf re-hosts/serves outlet photos; it must not advertise them as its
  // own images in Google Images).
  it("LEG-04: never emits an <image:image> extension or an outlet CDN URL", async () => {
    fixture.clusters = [
      {
        id: "active-1",
        is_archived: false,
        article_count: 5,
        updated_at: "2026-09-05T00:00:00.000Z",
        cluster_articles: [
          { articles: { image_url: "https://cdn.outlet.example/foto.jpg" } },
        ],
      },
    ];
    const res = await callFile("clusters-2026-09.xml");
    const body = await res.text();
    expect(body).not.toContain("<image:image>");
    expect(body).not.toContain("cdn.outlet.example");
  });
});
