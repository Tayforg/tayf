import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/takip -- the read side of "Takip ettiklerim". It reuses the two
// existing readers (searchClusters = the /?q= path, getTopicClusters = /konu),
// so both are mocked here; their Supabase behaviour is covered next to them.
// Every test uses its own x-real-ip so the process-local limiter state of one
// test can never bleed into another.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const searchClustersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => searchClustersMock(q),
}));

const getTopicClustersMock = vi.hoisted(() => vi.fn());
// isTopicSlug stays REAL (it is the authoritative server-side slug check).
vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: (slug: string, page: number) =>
      getTopicClustersMock(slug, page),
  };
});

import { GET } from "@/app/api/takip/route";

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function call(search: string, ip: string = nextIp()): Promise<Response> {
  return GET(
    new Request(`http://tayf.test/api/takip${search}`, {
      headers: { "x-real-ip": ip },
    }),
  );
}

const PUBLIC_CACHE =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

interface BundleOpts {
  id: string;
  title?: string;
  articleCount?: number;
  effectiveArticleCount?: number;
  isBlindspot?: unknown;
  biases?: string[];
  /** Per-source `kind`, aligned with `biases` by index; omitted = no kind (voting). */
  kinds?: Array<string | null | undefined>;
  firstPublished?: string;
  updatedAt?: string;
}

function bundle(o: BundleOpts) {
  return {
    cluster: {
      id: o.id,
      title_tr: o.title ?? `Başlık ${o.id}`,
      summary_tr: "x",
      bias_distribution: {},
      is_blindspot: o.isBlindspot ?? false,
      blindspot_side: null,
      article_count: o.articleCount ?? 3,
      first_published: o.firstPublished ?? "2026-10-22T08:00:00+00:00",
      updated_at: o.updatedAt ?? "2026-10-22T09:30:00+00:00",
    },
    articles: [],
    sources: (o.biases ?? ["center"]).map((bias, i) => ({
      id: `s${i}`,
      name: `Kaynak ${i}`,
      bias,
      ...(o.kinds !== undefined ? { kind: o.kinds[i] } : {}),
    })),
    ...(o.effectiveArticleCount !== undefined
      ? { effectiveArticleCount: o.effectiveArticleCount }
      : {}),
  };
}

beforeEach(() => {
  searchClustersMock.mockReset();
  getTopicClustersMock.mockReset();
  searchClustersMock.mockResolvedValue({ ok: true, bundles: [] });
  getTopicClustersMock.mockResolvedValue({ bundles: [], hasMore: false, page: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/takip -- q (keyword) path", () => {
  it("calls searchClusters with the NORMALISED keyword and answers 200", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [bundle({ id: "c1" })],
    });

    const res = await call(`?q=${encodeURIComponent("  İMAMOĞLU   Davası ")}`);

    expect(searchClustersMock).toHaveBeenCalledTimes(1);
    expect(searchClustersMock).toHaveBeenCalledWith("imamoğlu davası");
    expect(getTopicClustersMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["c1"]);
  });

  it("answers 200 with an empty items array when nothing matches", async () => {
    const res = await call("?q=seçim");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});

describe("GET /api/takip -- konu (topic) path", () => {
  it("calls getTopicClusters(slug, 1) and answers 200", async () => {
    getTopicClustersMock.mockResolvedValue({
      bundles: [bundle({ id: "k1" }), bundle({ id: "k2" })],
      hasMore: true,
      page: 1,
    });

    const res = await call("?konu=ekonomi");

    expect(getTopicClustersMock).toHaveBeenCalledTimes(1);
    expect(getTopicClustersMock).toHaveBeenCalledWith("ekonomi", 1);
    expect(searchClustersMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["k1", "k2"]);
  });
});

// search_cluster_ids orders by article_count desc with NO date window, so a
// keyword follow arrives most-corroborated-first, not newest-first. The route
// re-orders a keyword answer newest-first (by first_published) so the feed and
// its "yeni" badge read the freshest of what the search returned; a topic
// answer keeps the reader's own updated_at order untouched.
describe("GET /api/takip -- ordering", () => {
  it("q path: newest first_published first, regardless of the corroboration order it arrived in", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({ id: "old-big", articleCount: 40, firstPublished: "2026-09-01T08:00:00+00:00" }),
        bundle({ id: "new-small", articleCount: 3, firstPublished: "2026-10-22T07:00:00+00:00" }),
        bundle({ id: "mid", articleCount: 12, firstPublished: "2026-10-10T08:00:00+00:00" }),
      ],
    });
    const res = await call("?q=seçim");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["new-small", "mid", "old-big"]);
  });

  it("q path: compares instants, not strings (+00:00 vs Z, different offsets)", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        // 10:00Z
        bundle({ id: "a", firstPublished: "2026-10-22T10:00:00.000Z" }),
        // 10:30Z written with an offset: string order would put it BEFORE "...T10:00".
        bundle({ id: "b", firstPublished: "2026-10-22T13:30:00+03:00" }),
        // 09:59:59Z
        bundle({ id: "c", firstPublished: "2026-10-22T09:59:59+00:00" }),
      ],
    });
    const res = await call("?q=seçim");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("q path: ties keep the arrival order; an unparseable date sorts last", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({ id: "bad", firstPublished: "not-a-date" }),
        bundle({ id: "t1", firstPublished: "2026-10-22T08:00:00+00:00" }),
        bundle({ id: "t2", firstPublished: "2026-10-22T08:00:00+00:00" }),
      ],
    });
    const res = await call("?q=seçim");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["t1", "t2", "bad"]);
  });

  it("q path: orders BEFORE the 10-item cap, so the cap drops the oldest, not the least corroborated", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: Array.from({ length: 12 }, (_, i) =>
        bundle({
          id: `c${i}`,
          // c0 is the most corroborated and the OLDEST; c11 is the newest.
          firstPublished: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        }),
      ),
    });
    const res = await call("?q=deprem");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(10);
    expect(body.items[0]?.id).toBe("c11");
    expect(body.items.map((i) => i.id)).not.toContain("c0");
    expect(body.items.map((i) => i.id)).not.toContain("c1");
  });

  it("konu path: keeps the topic reader's order (it already sorts by updated_at)", async () => {
    getTopicClustersMock.mockResolvedValue({
      bundles: [
        bundle({ id: "k-old", firstPublished: "2026-10-01T08:00:00+00:00" }),
        bundle({ id: "k-new", firstPublished: "2026-10-22T08:00:00+00:00" }),
      ],
      hasMore: false,
      page: 1,
    });
    const res = await call("?konu=ekonomi");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["k-old", "k-new"]);
  });

  it("does not mutate the bundle array the reader returned (it sits behind a cache)", async () => {
    const bundles = [
      bundle({ id: "x1", firstPublished: "2026-10-01T08:00:00+00:00" }),
      bundle({ id: "x2", firstPublished: "2026-10-22T08:00:00+00:00" }),
    ];
    searchClustersMock.mockResolvedValue({ ok: true, bundles });
    await call("?q=seçim");
    expect(bundles.map((b) => b.cluster.id)).toEqual(["x1", "x2"]);
  });
});

describe("GET /api/takip -- validation (400)", () => {
  const long41 = "a".repeat(41);
  const raw201 = "a".repeat(201);
  const cases: Array<[string, string]> = [
    ["no params", ""],
    ["both q and konu", "?q=seçim&konu=ekonomi"],
    ["q too short", "?q=a"],
    ["q 41 chars", `?q=${long41}`],
    ["q 201 raw chars", `?q=${raw201}`],
    ["q only whitespace", `?q=${encodeURIComponent("   ")}`],
    ["q with a control character", "?q=%00ab"],
    ["q empty", "?q="],
    ["q repeated", "?q=seçim&q=deprem"],
    ["konu repeated", "?konu=spor&konu=dunya"],
    ["konu=politika (no hub)", "?konu=politika"],
    ["konu traversal", `?konu=${encodeURIComponent("../x")}`],
    ["konu wrong case", "?konu=Ekonomi"],
    ["konu empty", "?konu="],
    ["unrelated param only", "?foo=bar"],
  ];

  it.each(cases)("400s for %s without touching a reader", async (_name, search) => {
    const res = await call(search);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(searchClustersMock).not.toHaveBeenCalled();
    expect(getTopicClustersMock).not.toHaveBeenCalled();
  });

  it("uses the Turkish keyword message for a bad q", async () => {
    const res = await call("?q=a");
    expect(await res.json()).toEqual({ error: "Geçersiz anahtar kelime" });
  });
});

describe("GET /api/takip -- upstream failure (503)", () => {
  it("503s no-store with Retry-After 60 when the search is ok:false", async () => {
    searchClustersMock.mockResolvedValue({ ok: false });
    const res = await call("?q=seçim");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("503s no-store with Retry-After 60 when the topic read is null", async () => {
    getTopicClustersMock.mockResolvedValue(null);
    const res = await call("?konu=spor");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("never sets a public cache header when a reader throws (500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    searchClustersMock.mockRejectedValue(new Error("boom"));
    const res = await call("?q=seçim");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control") ?? "").not.toContain("public");
  });
});

describe("GET /api/takip -- item shape", () => {
  it("caps the list at 10 items", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: Array.from({ length: 12 }, (_, i) => bundle({ id: `c${i}` })),
    });
    const res = await call("?q=deprem");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(10);
    expect(body.items[0]?.id).toBe("c0");
    expect(body.items[9]?.id).toBe("c9");
  });

  it("maps exactly the documented fields", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({
          id: "c1",
          title: "Deprem sonrası",
          articleCount: 7,
          isBlindspot: true,
          biases: ["pro_government", "center", "opposition", "opposition"],
        }),
      ],
    });
    const res = await call("?q=deprem");
    const body = await res.json();
    expect(body).toEqual({
      items: [
        {
          id: "c1",
          title: "Deprem sonrası",
          firstPublished: "2026-10-22T08:00:00+00:00",
          updatedAt: "2026-10-22T09:30:00+00:00",
          sourceCount: 7,
          isBlindspot: true,
          zoneLine: "İktidar 1 · Bağımsız 1 · Muhalefet 2",
        },
      ],
    });
  });

  it("builds the zone line on the VOTING basis: aggregator and niche sources are not counted", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({
          id: "v1",
          articleCount: 5,
          biases: ["pro_government", "opposition", "center", "center", "opposition"],
          kinds: ["outlet", "wire", "aggregator", "niche", "aggregator"],
        }),
      ],
    });
    const res = await call("?q=seçim");
    const body = (await res.json()) as {
      items: Array<{ zoneLine: string; sourceCount: number }>;
    };
    // The card's tally: 1 outlet (iktidar) + 1 wire (muhalefet). The
    // aggregator (x2) and the niche feed are listed on the card, never voted.
    expect(body.items[0]?.zoneLine).toBe("İktidar 1 · Bağımsız 0 · Muhalefet 1");
    // "N kaynak" is not a voting tally and stays the cluster's own count.
    expect(body.items[0]?.sourceCount).toBe(5);
  });

  it("counts a source with a missing or null kind as voting (legacy rows)", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({
          id: "v2",
          biases: ["pro_government", "center", "opposition", "opposition"],
          kinds: [undefined, null, "outlet", "aggregator"],
        }),
      ],
    });
    const res = await call("?q=seçim");
    const body = (await res.json()) as { items: Array<{ zoneLine: string }> };
    expect(body.items[0]?.zoneLine).toBe("İktidar 1 · Bağımsız 1 · Muhalefet 1");
  });

  it("the topic path uses the same voting basis", async () => {
    getTopicClustersMock.mockResolvedValue({
      bundles: [
        bundle({
          id: "v3",
          biases: ["center", "center"],
          kinds: ["outlet", "aggregator"],
        }),
      ],
      hasMore: false,
      page: 1,
    });
    const res = await call("?konu=ekonomi");
    const body = (await res.json()) as { items: Array<{ zoneLine: string }> };
    expect(body.items[0]?.zoneLine).toBe("İktidar 0 · Bağımsız 1 · Muhalefet 0");
  });

  it("prefers effectiveArticleCount (wire-collapsed) over article_count", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [bundle({ id: "w1", articleCount: 9, effectiveArticleCount: 2 })],
    });
    const res = await call("?q=ajans");
    const body = (await res.json()) as { items: Array<{ sourceCount: number }> };
    expect(body.items[0]?.sourceCount).toBe(2);
  });

  it("keeps a legitimate effectiveArticleCount of 0 (nullish, not falsy, fallback)", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [bundle({ id: "w0", articleCount: 5, effectiveArticleCount: 0 })],
    });
    const res = await call("?q=ajans");
    const body = (await res.json()) as { items: Array<{ sourceCount: number }> };
    expect(body.items[0]?.sourceCount).toBe(0);
  });

  it("coerces isBlindspot strictly to a boolean", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({ id: "b1", isBlindspot: "true" }),
        bundle({ id: "b2", isBlindspot: null }),
        bundle({ id: "b3", isBlindspot: true }),
      ],
    });
    const res = await call("?q=kör");
    const body = (await res.json()) as {
      items: Array<{ id: string; isBlindspot: boolean }>;
    };
    expect(body.items.map((i) => i.isBlindspot)).toEqual([false, false, true]);
  });
});

describe("GET /api/takip -- rate limit", () => {
  it("allows 40 requests from one IP, then 429s the 41st with Retry-After", async () => {
    const ip = nextIp();
    for (let i = 0; i < 40; i++) {
      const ok = await call("?q=seçim", ip);
      expect(ok.status).toBe(200);
    }
    const res = await call("?q=seçim", ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toEqual({
      error: "Çok fazla istek",
      details: { retryAfterMs: expect.any(Number) },
    });
    expect(searchClustersMock).toHaveBeenCalledTimes(40);
  });

  it("rate-limits before validating (a bad request still spends a token)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 40; i++) await call("?q=a", ip);
    const res = await call("?q=a", ip);
    expect(res.status).toBe(429);
  });

  it("does not let one IP's burst affect another", async () => {
    const hot = nextIp();
    for (let i = 0; i < 41; i++) await call("?q=seçim", hot);
    const res = await call("?q=seçim", nextIp());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/takip -- privacy", () => {
  it("never writes the keyword to any console channel", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    searchClustersMock.mockResolvedValueOnce({ ok: false });
    await call("?q=gizlikelime");
    await call("?q=gizlikelime&konu=spor");
    await call(`?q=${"x".repeat(300)}gizlikelime`);
    await call("?konu=gizlikelime");
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).not.toContain("gizlikelime");
  });
});
