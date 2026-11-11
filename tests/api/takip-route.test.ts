import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/takip -- the read side of "Takip ettiklerim". It reuses the three
// existing readers (searchClusters = the /?q= path, getTopicClusters = /konu,
// getEntityHub = /gundem/[key]), so all are mocked here; their Supabase
// behaviour is covered next to them.
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

const getEntityHubMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: (key: string) => getEntityHubMock(key),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GET } from "@/app/api/takip/route";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

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
  /** Per-source display name, aligned with `biases` by index; omitted = 'Kaynak i'. */
  names?: string[];
  /** Member articles, each pointing at a source index (h118-english-1). */
  articles?: Array<{ title: string; source: number; sourceName?: string }>;
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
    articles: (o.articles ?? []).map((a, i) => ({
      id: `a${i}`,
      title: a.title,
      url: `https://example.test/${o.id}/${i}`,
      published_at: "2026-10-22T08:00:00+00:00",
      source_id: `s${a.source}`,
      ...(a.sourceName !== undefined ? { source_name: a.sourceName } : {}),
    })),
    sources: (o.biases ?? ["center"]).map((bias, i) => ({
      id: `s${i}`,
      name: o.names?.[i] ?? `Kaynak ${i}`,
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
  getEntityHubMock.mockReset();
  searchClustersMock.mockResolvedValue({ ok: true, bundles: [] });
  getTopicClustersMock.mockResolvedValue({ bundles: [], hasMore: false, page: 1 });
  getEntityHubMock.mockResolvedValue({ bundles: [], total: 0, asOfMs: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/takip -- q (keyword) path", () => {
  // h112-follows-2: the keyword is normalised for display (format characters out,
  // whitespace collapsed, case kept); searchClusters canonicalises it itself
  // (canonicalSearchQuery lower-cases with Turkish rules and the SQL folds ı/i), so
  // the search side needs no change: 'IMF' and 'imf' reach the same result list.
  it("calls searchClusters with the normalised keyword (case kept) and answers 200", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [bundle({ id: "c1" })],
    });

    const res = await call(`?q=${encodeURIComponent("  İMAMOĞLU   Davası ")}`);

    expect(searchClustersMock).toHaveBeenCalledTimes(1);
    expect(searchClustersMock).toHaveBeenCalledWith("İMAMOĞLU Davası");
    expect(getTopicClustersMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["c1"]);
  });

  // h60-forms-3: the archive (/?q=) searches up to 64 characters, so a follow
  // of 41..64 characters must run exactly that search, not 400.
  it.each([
    ["a 42-character search", "cumhurbaşkanı erdoğan azerbaycan'a gidecek", 42],
    ["exactly 64 characters", "a".repeat(64), 64],
  ])("accepts %s and calls searchClusters once", async (_name, q, length) => {
    expect([...q]).toHaveLength(length);
    const res = await call(`?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    expect(searchClustersMock).toHaveBeenCalledTimes(1);
    expect(searchClustersMock).toHaveBeenCalledWith(q);
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
  const long65 = "a".repeat(65);
  const raw201 = "a".repeat(201);
  const cases: Array<[string, string]> = [
    ["no params", ""],
    ["both q and konu", "?q=seçim&konu=ekonomi"],
    ["q too short", "?q=a"],
    ["q 65 chars (one over the archive's 64-char cut)", `?q=${long65}`],
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
    expect(getEntityHubMock).not.toHaveBeenCalled();
  });

  it("uses the Turkish keyword message for a bad q", async () => {
    const res = await call("?q=a");
    expect(await res.json()).toEqual({ error: "Geçersiz anahtar kelime" });
  });
});

// h43-entities-1: a /gundem/<key> hub follow reads through getEntityHub (the
// hub's aliases, excludes and word boundaries), NOT the generic stemmed archive
// search. ?q=DEVA returned 9 "devam" collisions out of 10; ?gundem=deva must
// return only what /gundem/deva itself lists.
describe("GET /api/takip -- gundem (entity hub) path", () => {
  it("calls getEntityHub(key) with the validated key and answers 200", async () => {
    getEntityHubMock.mockResolvedValue({
      bundles: [bundle({ id: "h1" }), bundle({ id: "h2" })],
      total: 2,
      asOfMs: 1,
    });

    const res = await call("?gundem=deva");

    expect(getEntityHubMock).toHaveBeenCalledTimes(1);
    expect(getEntityHubMock).toHaveBeenCalledWith("deva");
    expect(searchClustersMock).not.toHaveBeenCalled();
    expect(getTopicClustersMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["h1", "h2"]);
  });

  it("keeps the hub's own order (the RPC already returns first_published desc)", async () => {
    getEntityHubMock.mockResolvedValue({
      bundles: [
        bundle({ id: "newest", firstPublished: "2026-11-05T08:00:00+00:00" }),
        bundle({ id: "middle", firstPublished: "2026-11-03T08:00:00+00:00" }),
        bundle({ id: "oldest", firstPublished: "2026-11-01T08:00:00+00:00" }),
      ],
      total: 3,
      asOfMs: 1,
    });
    const res = await call("?gundem=aym");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("caps the list at FOLLOW_ITEMS_MAX (10), keeping the newest end of the hub order", async () => {
    getEntityHubMock.mockResolvedValue({
      bundles: Array.from({ length: 20 }, (_, i) => bundle({ id: `h${i}` })),
      total: 120,
      asOfMs: 1,
    });
    const res = await call("?gundem=chp");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(10);
    expect(body.items[0]?.id).toBe("h0");
    expect(body.items[9]?.id).toBe("h9");
  });

  it("maps exactly the same fields as the q and konu paths", async () => {
    const b = bundle({
      id: "h1",
      title: "DEVA Partisi kongresi",
      articleCount: 7,
      isBlindspot: true,
      biases: ["pro_government", "center", "opposition", "opposition"],
    });
    getEntityHubMock.mockResolvedValue({ bundles: [b], total: 1, asOfMs: 1 });
    const hub = await (await call("?gundem=deva")).json();

    searchClustersMock.mockResolvedValue({ ok: true, bundles: [b] });
    const keyword = await (await call("?q=deva%20partisi")).json();

    expect(hub).toEqual({
      items: [
        {
          id: "h1",
          title: "DEVA Partisi kongresi",
          firstPublished: "2026-10-22T08:00:00+00:00",
          updatedAt: "2026-10-22T09:30:00+00:00",
          sourceCount: 7,
          isBlindspot: true,
          zoneLine: "İktidar 1 · Bağımsız 1 · Muhalefet 2",
          countHead: "7 kaynak (4 sınıflandırılmış)",
        },
      ],
    });
    expect(hub).toEqual(keyword);
  });

  it("answers 200 with an empty items array for a hub with no clusters", async () => {
    const res = await call("?gundem=hamas");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("accepts every curated RISING_ENTITIES key", async () => {
    expect(RISING_ENTITIES.length).toBeGreaterThanOrEqual(60);
    for (const e of RISING_ENTITIES) {
      getEntityHubMock.mockClear();
      const res = await call(`?gundem=${e.key}`);
      expect(res.status, e.key).toBe(200);
      expect(getEntityHubMock).toHaveBeenCalledWith(e.key);
    }
  });

  it("503s no-store with Retry-After 60 when the hub read is null", async () => {
    getEntityHubMock.mockResolvedValue(null);
    const res = await call("?gundem=deva");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "Şu an yüklenemedi" });
  });

  it("never sets a public cache header when the hub reader throws (500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getEntityHubMock.mockRejectedValue(new Error("boom"));
    const res = await call("?gundem=deva");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control") ?? "").not.toContain("public");
  });

  it("does not mutate the bundle array the reader returned (it sits behind a cache)", async () => {
    const bundles = [bundle({ id: "x1" }), bundle({ id: "x2" })];
    getEntityHubMock.mockResolvedValue({ bundles, total: 2, asOfMs: 1 });
    await call("?gundem=deva");
    expect(bundles.map((b) => b.cluster.id)).toEqual(["x1", "x2"]);
  });

  it("spends a rate-limit token like the other paths (429 after 40)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 40; i++) {
      expect((await call("?gundem=deva", ip)).status).toBe(200);
    }
    const res = await call("?gundem=deva", ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getEntityHubMock).toHaveBeenCalledTimes(40);
  });
});

describe("GET /api/takip -- gundem validation (400)", () => {
  const badKey: Array<[string, string]> = [
    ["unknown key", "?gundem=xyz"],
    ["upper-case key", "?gundem=DEVA"],
    ["a label, not a key", `?gundem=${encodeURIComponent("Özgür Özel")}`],
    ["padded key", "?gundem=deva%20"],
    ["empty key", "?gundem="],
    ["traversal", `?gundem=${encodeURIComponent("../x")}`],
    ["Object.prototype name", "?gundem=__proto__"],
    ["constructor", "?gundem=constructor"],
    ["a control character", "?gundem=%00deva"],
    ["a very long key", `?gundem=${"a".repeat(5000)}`],
  ];

  it.each(badKey)("400s 'Geçersiz gündem' for %s without touching a reader", async (_name, search) => {
    const res = await call(search);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "Geçersiz gündem" });
    expect(getEntityHubMock).not.toHaveBeenCalled();
    expect(searchClustersMock).not.toHaveBeenCalled();
    expect(getTopicClustersMock).not.toHaveBeenCalled();
  });

  const combos: Array<[string, string]> = [
    ["gundem and q", "?gundem=deva&q=x"],
    ["q and gundem", "?q=seçim&gundem=deva"],
    ["gundem and konu", "?gundem=deva&konu=ekonomi"],
    ["all three", "?q=seçim&konu=ekonomi&gundem=deva"],
    ["gundem repeated", "?gundem=deva&gundem=aym"],
    ["gundem repeated with the same key", "?gundem=deva&gundem=deva"],
    ["gundem with an invalid q", "?gundem=deva&q=a"],
  ];

  it.each(combos)("400s 'Geçersiz istek' for %s without touching a reader", async (_name, search) => {
    const res = await call(search);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Geçersiz istek" });
    expect(getEntityHubMock).not.toHaveBeenCalled();
    expect(searchClustersMock).not.toHaveBeenCalled();
    expect(getTopicClustersMock).not.toHaveBeenCalled();
  });

  it("does not echo or log the rejected value", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const res = await call("?gundem=gizlideger");
    expect(JSON.stringify(await res.json())).not.toContain("gizlideger");
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).not.toContain("gizlideger");
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

  // searchClusters answers { ok: false } immediately (no RPC) when this
  // instance already has MAX_IN_FLIGHT_SEARCHES searches running (h30-abuse-1);
  // the route must treat that exactly like an outage: a retryable 503 that no
  // CDN may keep.
  it("search saturated ({ok:false}) -> 503, Cache-Control no-store, Retry-After 60", async () => {
    searchClustersMock.mockResolvedValue({ ok: false });
    const res = await call("?q=deprem");
    expect(searchClustersMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).not.toContain("public");
    expect(await res.json()).toEqual({ error: "Şu an yüklenemedi" });
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
          countHead: "7 kaynak (4 sınıflandırılmış)",
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
      items: Array<{ zoneLine: string; sourceCount: number; countHead: string }>;
    };
    // The card's tally: 1 outlet (iktidar) + 1 wire (muhalefet). The
    // aggregator (x2) and the niche feed are listed on the card, never voted.
    expect(body.items[0]?.zoneLine).toBe("İktidar 1 · Bağımsız 0 · Muhalefet 1");
    // "N kaynak" is not a voting tally and stays the cluster's own count.
    expect(body.items[0]?.sourceCount).toBe(5);
    // ...and the head says so: 5 members, 2 of them classified.
    expect(body.items[0]?.countHead).toBe("5 kaynak (2 sınıflandırılmış)");
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

// ---------------------------------------------------------------------------
// h118-english-1 (WCAG 3.1.2 and the "not compared" wording). 2dab7e87 is an
// all-English cluster (Daily Sabah + TRT World): /api/takip printed its English
// title with no lang, and the zone line 'İktidar 2 · Bağımsız 0 · Muhalefet 0',
// which reads as a coverage claim although no Turkish outlet could have matched
// the story. The item now carries lang 'en' (the ClusterCard / related-clusters
// headline rule: an English member's own title, no Turkish member with the same
// title) and an all-English cluster's zone line says it was not compared. Both
// keys are absent / unchanged for every Turkish and mixed item.
// ---------------------------------------------------------------------------
describe("GET /api/takip -- English-only clusters (h118-english-1)", () => {
  const EN_TITLE = "Turkish president Erdoğan, UN chief Guterres discuss regional, global issues at COP31";
  const QUALIFIED_ZONE_LINE =
    "Yalnızca İngilizce kaynaklar · Türkçe haberlerle karşılaştırılmadı";

  type Item = {
    id: string;
    title: string;
    zoneLine: string;
    countHead: string;
    lang?: string;
  };

  async function itemFor(b: ReturnType<typeof bundle>, search = "?q=Guterres"): Promise<Item> {
    searchClustersMock.mockResolvedValue({ ok: true, bundles: [b] });
    const res = await call(search);
    const body = (await res.json()) as { items: Item[] };
    return body.items[0] as Item;
  }

  function englishBundle(extra: Partial<BundleOpts> = {}) {
    return bundle({
      id: "2dab7e87",
      title: EN_TITLE,
      articleCount: 2,
      biases: ["pro_government", "pro_government"],
      names: ["Daily Sabah", "TRT World"],
      articles: [
        { title: EN_TITLE, source: 0 },
        { title: "Erdogan, Guterres discuss regional, global issues at COP31", source: 1 },
      ],
      ...extra,
    });
  }

  it("an all-English bundle gets lang 'en' and the qualified zone line; the count head is unchanged", async () => {
    const item = await itemFor(englishBundle());

    expect(item.lang).toBe("en");
    expect(item.zoneLine).toBe(QUALIFIED_ZONE_LINE);
    expect(item.countHead).toBe("2 kaynak");
    expect(item.title).toBe(EN_TITLE);
  });

  it("a mixed bundle with a Turkish title has no lang key and today's zone line", async () => {
    const item = await itemFor(
      bundle({
        id: "mixed-tr",
        title: "Cumhurbaşkanı Erdoğan, Guterres ile görüştü",
        articleCount: 2,
        biases: ["pro_government", "pro_government"],
        names: ["Daily Sabah", "A Haber"],
        articles: [
          { title: EN_TITLE, source: 0 },
          { title: "Cumhurbaşkanı Erdoğan, Guterres ile görüştü", source: 1 },
        ],
      }),
    );

    expect("lang" in item).toBe(false);
    expect(item.zoneLine).toBe("İktidar 2 · Bağımsız 0 · Muhalefet 0");
  });

  it("a Turkish bundle is byte-identical to before: same keys, no lang", async () => {
    const item = await itemFor(
      bundle({
        id: "tr-1",
        articleCount: 3,
        biases: ["pro_government", "center", "opposition"],
        names: ["A Haber", "Sözcü", "Halk TV"],
        articles: [{ title: "Başlık tr-1", source: 1 }],
      }),
    );

    expect(Object.keys(item).sort()).toEqual(
      ["countHead", "firstPublished", "id", "isBlindspot", "sourceCount", "title", "updatedAt", "zoneLine"].sort(),
    );
    expect(item.zoneLine).toBe("İktidar 1 · Bağımsız 1 · Muhalefet 1");
  });

  it("a mixed bundle whose title IS the English member's own title gets lang 'en' but keeps today's zone line", async () => {
    // The home card's rule (h59-english-2): an English member's title is the
    // headline and no Turkish member carries it too. The cluster is not isolated.
    const item = await itemFor(
      bundle({
        id: "mixed-en",
        title: EN_TITLE,
        articleCount: 2,
        biases: ["pro_government", "pro_government"],
        names: ["Daily Sabah", "A Haber"],
        articles: [
          { title: EN_TITLE, source: 0 },
          { title: "Cumhurbaşkanı Erdoğan, Guterres ile görüştü", source: 1 },
        ],
      }),
    );

    expect(item.lang).toBe("en");
    expect(item.zoneLine).toBe("İktidar 2 · Bağımsız 0 · Muhalefet 0");
  });

  it("a Turkish member carrying the same title vetoes lang", async () => {
    const item = await itemFor(
      bundle({
        id: "veto",
        title: "Aynı başlık",
        articleCount: 2,
        biases: ["pro_government", "pro_government"],
        names: ["Daily Sabah", "A Haber"],
        articles: [
          { title: "Aynı başlık", source: 0 },
          { title: "Aynı başlık", source: 1 },
        ],
      }),
    );

    expect("lang" in item).toBe(false);
  });

  it("an all-English cluster whose headline is not any member's own title (a rewrite) gets the zone line but no lang", async () => {
    const item = await itemFor(
      englishBundle({ title: "Erdoğan ve Guterres COP31'de bir araya geldi" }),
    );

    expect("lang" in item).toBe(false);
    expect(item.zoneLine).toBe(QUALIFIED_ZONE_LINE);
  });

  it("an article's own source_name stands in for a source the bundle does not list", async () => {
    const b = englishBundle({
      articles: [
        { title: EN_TITLE, source: 0, sourceName: "Daily Sabah" },
        { title: "Other", source: 5, sourceName: "TRT World" },
      ],
    });
    const item = await itemFor(b);

    expect(item.lang).toBe("en");
  });

  it("a headline that differs from its member title only by an entity residue still matches", async () => {
    const item = await itemFor(
      englishBundle({
        title: "Türkiye &amp; Azerbaijan sign deals",
        articles: [
          { title: "Türkiye & Azerbaijan sign deals", source: 0 },
          { title: "Other", source: 1 },
        ],
      }),
    );

    expect(item.lang).toBe("en");
    // The title itself is printed exactly as stored.
    expect(item.title).toBe("Türkiye &amp; Azerbaijan sign deals");
  });

  it("a bundle with no sources is never isolated", async () => {
    const b = englishBundle();
    const empty = { ...b, sources: [] };
    searchClustersMock.mockResolvedValue({ ok: true, bundles: [empty] });
    const res = await call("?q=Guterres");
    const body = (await res.json()) as { items: Item[] };

    expect(body.items[0]?.zoneLine).toBe("İktidar 0 · Bağımsız 0 · Muhalefet 0");
    expect("lang" in (body.items[0] as object)).toBe(false);
  });

  it("the topic and hub paths mark an English-only cluster the same way", async () => {
    getTopicClustersMock.mockResolvedValue({
      bundles: [englishBundle()],
      hasMore: false,
      page: 1,
    });
    const topic = (await (await call("?konu=dunya")).json()) as { items: Item[] };
    expect(topic.items[0]?.lang).toBe("en");
    expect(topic.items[0]?.zoneLine).toBe(QUALIFIED_ZONE_LINE);

    const key = RISING_ENTITIES[0]?.key as string;
    getEntityHubMock.mockResolvedValue({ bundles: [englishBundle()], total: 1, asOfMs: 0 });
    const hub = (await (await call(`?gundem=${encodeURIComponent(key)}`)).json()) as {
      items: Item[];
    };
    expect(hub.items[0]?.lang).toBe("en");
    expect(hub.items[0]?.zoneLine).toBe(QUALIFIED_ZONE_LINE);
  });

  it("the qualifier carries no coverage number, and the count head still counts every member", async () => {
    const item = await itemFor(
      englishBundle({ articleCount: 4, biases: ["pro_government", "pro_government"] }),
    );

    expect(item.zoneLine).not.toMatch(/İktidar|Bağımsız|Muhalefet/);
    expect(item.countHead).toBe("4 kaynak (2 sınıflandırılmış)");
  });

  it("source guard: the route keeps no literal of the English-only wording (it reads ENGLISH_ONLY_ZONE_LINE from source-language.ts)", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/app/api/takip/route.ts"),
      "utf8",
    );
    expect(source).not.toContain("Yalnızca İngilizce");
    expect(source).not.toContain("karşılaştırılmadı");
    const sourceLanguageImport =
      /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/sources\/source-language"/.exec(source);
    expect(sourceLanguageImport?.[1]).toContain("ENGLISH_ONLY_ZONE_LINE");
  });
});

// h47-personal-1: every other surface that prints a zone line puts
// sourceCountHead(total, votingCounts) in front of it ("5 kaynak (4
// sınıflandırılmış) · İktidar 4 ..."), so the figures add up. /takip printed a
// bare "N kaynak" next to a voting-only zone line, and 18 of 30 live rows did
// not add up. The route now sends the head beside sourceCount and zoneLine.
describe("GET /api/takip -- countHead (all three paths)", () => {
  type Bundle = ReturnType<typeof bundle>;
  type Item = {
    sourceCount: number;
    zoneLine: string;
    countHead?: string;
  };
  const paths: Array<[string, string, (bundles: Bundle[]) => void]> = [
    [
      "q",
      "?q=seçim",
      (bundles) => searchClustersMock.mockResolvedValue({ ok: true, bundles }),
    ],
    [
      "konu",
      "?konu=ekonomi",
      (bundles) =>
        getTopicClustersMock.mockResolvedValue({ bundles, hasMore: false, page: 1 }),
    ],
    [
      "gundem",
      "?gundem=deva",
      (bundles) =>
        getEntityHubMock.mockResolvedValue({ bundles, total: bundles.length, asOfMs: 1 }),
    ],
  ];

  async function firstItem(search: string): Promise<Item> {
    const res = await call(search);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[] };
    expect(body.items).toHaveLength(1);
    return body.items[0] as Item;
  }

  describe.each(paths)("%s path", (_name, search, serve) => {
    it("qualifies the count when only some members vote: '5 kaynak (4 sınıflandırılmış)'", async () => {
      serve([
        bundle({
          id: "h1",
          articleCount: 9,
          effectiveArticleCount: 5,
          biases: [
            "pro_government",
            "pro_government",
            "pro_government",
            "pro_government",
            "center",
          ],
          kinds: ["outlet", "outlet", "wire", "outlet", "aggregator"],
        }),
      ]);
      const it1 = await firstItem(search);
      expect(it1.sourceCount).toBe(5);
      expect(it1.zoneLine).toBe("İktidar 4 · Bağımsız 0 · Muhalefet 0");
      expect(it1.countHead).toBe("5 kaynak (4 sınıflandırılmış)");
    });

    it("keeps the bare count when the voting total equals it: '2 kaynak'", async () => {
      serve([
        bundle({
          id: "h2",
          articleCount: 2,
          biases: ["pro_government", "opposition"],
          kinds: ["outlet", "outlet"],
        }),
      ]);
      const it2 = await firstItem(search);
      expect(it2.zoneLine).toBe("İktidar 1 · Bağımsız 0 · Muhalefet 1");
      expect(it2.countHead).toBe("2 kaynak");
    });

    it("keeps the bare count when the voting total exceeds the wire-collapsed count", async () => {
      // 4 voting members on the wire but effectiveArticleCount collapsed to 2:
      // sourceCountHead's voting >= total rule prints the bare '2 kaynak'.
      serve([
        bundle({
          id: "h3",
          articleCount: 4,
          effectiveArticleCount: 2,
          biases: ["pro_government", "pro_government", "center", "opposition"],
          kinds: ["outlet", "outlet", "outlet", "outlet"],
        }),
      ]);
      const it3 = await firstItem(search);
      expect(it3.sourceCount).toBe(2);
      expect(it3.zoneLine).toBe("İktidar 2 · Bağımsız 1 · Muhalefet 1");
      expect(it3.countHead).toBe("2 kaynak");
    });

    it("falls back to the cluster's article_count when there is no effective count", async () => {
      serve([
        bundle({
          id: "h4",
          articleCount: 6,
          biases: ["center", "center", "center", "center"],
          kinds: ["outlet", "outlet", "outlet", "aggregator"],
        }),
      ]);
      const it4 = await firstItem(search);
      expect(it4.sourceCount).toBe(6);
      expect(it4.countHead).toBe("6 kaynak (3 sınıflandırılmış)");
    });

    it("a bundle with no voting source reads '0 sınıflandırılmış'", async () => {
      serve([
        bundle({
          id: "h5",
          articleCount: 3,
          biases: ["center", "center"],
          kinds: ["aggregator", "niche"],
        }),
      ]);
      const it5 = await firstItem(search);
      expect(it5.zoneLine).toBe("İktidar 0 · Bağımsız 0 · Muhalefet 0");
      expect(it5.countHead).toBe("3 kaynak (0 sınıflandırılmış)");
    });
  });
});

// h47-personal-2: the keyword caption says "En çok kaynaklı eşleşmeler ·
// yeniden eskiye" (the most-corroborated matches, newest first). Since
// migration 129 search_cluster_ids ranks by relevance (24 hits), so taking the
// 10 newest of those 24 hid the 20-, 12-, 12-, 9- and 7-source stories. The q
// path now picks a KEYWORD_POOL (12) by effective source count with a stable
// sort, shows that pool newest first, then applies the 10-item cap. The konu
// and gundem paths are untouched.
describe("GET /api/takip -- q path: most-corroborated pool, newest first", () => {
  type Row = { id: string; sourceCount: number };

  // index -> day: a higher index is a NEWER story, so the RPC (relevance)
  // order is not the recency order.
  const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString();

  it("keeps the 20-, 12-, 12-, 9- and 7-source stories out of a 24-hit relevance list, newest first, 10 items", async () => {
    const heavy: Record<number, number> = { 18: 20, 5: 12, 6: 12, 19: 9, 22: 7 };
    // Seven mid-corroborated fillers (4 sources) fill the rest of the 12-story
    // pool; every other hit, including the newest ones, has 2.
    const filler = new Set([0, 1, 2, 3, 4, 7, 8]);
    const bundles = Array.from({ length: 24 }, (_, i) =>
      bundle({
        id: `r${i}`,
        articleCount: heavy[i] ?? (filler.has(i) ? 4 : 2),
        firstPublished: day(i),
      }),
    );
    searchClustersMock.mockResolvedValue({ ok: true, bundles });

    const res = await call(`?q=${encodeURIComponent("ara seçim")}`);
    const body = (await res.json()) as { items: Row[] };
    const ids = body.items.map((i) => i.id);

    expect(body.items).toHaveLength(10);
    for (const must of ["r18", "r5", "r6", "r19", "r22"]) {
      expect(ids, must).toContain(must);
    }
    // The least corroborated and the newest hits (r20, r21, r23: 2 sources)
    // are not in the pool, so recency alone no longer picks the list.
    for (const out of ["r20", "r21", "r23"]) {
      expect(ids, out).not.toContain(out);
    }
    // Newest first inside the pool; the cap then drops the two OLDEST pool
    // members (r0, r1), never a heavily-sourced one.
    expect(ids).toEqual(["r22", "r19", "r18", "r8", "r7", "r6", "r5", "r4", "r3", "r2"]);
    expect(body.items.find((i) => i.id === "r18")?.sourceCount).toBe(20);
  });

  it("ties in effective count keep the RPC (relevance) order when choosing the pool (stable)", async () => {
    // 14 hits: t13 is the only heavier one; t0..t12 all tie at 3 and the
    // pool takes t13 plus the FIRST 11 ties in relevance order (t0..t10).
    // Later ties (t11, t12) are newer but lose to earlier relevance.
    const bundles = Array.from({ length: 14 }, (_, i) =>
      bundle({
        id: `t${i}`,
        articleCount: i === 13 ? 5 : 3,
        firstPublished: day(i),
      }),
    );
    searchClustersMock.mockResolvedValue({ ok: true, bundles });

    const res = await call("?q=seçim");
    const ids = ((await res.json()) as { items: Row[] }).items.map((i) => i.id);

    expect(ids).toEqual(["t13", "t10", "t9", "t8", "t7", "t6", "t5", "t4", "t3", "t2"]);
    expect(ids).not.toContain("t11");
    expect(ids).not.toContain("t12");
  });

  it("ranks the pool by the wire-collapsed effective count, not the raw article_count", async () => {
    // w is the NEWEST hit and has article_count 30, but only 2 independent
    // sources after wire collapse: twelve 3-source hits outrank it.
    const bundles = [
      ...Array.from({ length: 12 }, (_, i) =>
        bundle({ id: `n${i}`, articleCount: 3, firstPublished: day(i) }),
      ),
      bundle({
        id: "w",
        articleCount: 30,
        effectiveArticleCount: 2,
        firstPublished: day(20),
      }),
    ];
    searchClustersMock.mockResolvedValue({ ok: true, bundles });

    const res = await call("?q=ajans");
    const ids = ((await res.json()) as { items: Row[] }).items.map((i) => i.id);

    expect(ids).not.toContain("w");
    expect(ids[0]).toBe("n11");
  });

  it("does not mutate the cached bundle array while ranking the pool", async () => {
    const bundles = [
      bundle({ id: "m1", articleCount: 2, firstPublished: day(1) }),
      bundle({ id: "m2", articleCount: 9, firstPublished: day(2) }),
      bundle({ id: "m3", articleCount: 5, firstPublished: day(3) }),
    ];
    searchClustersMock.mockResolvedValue({ ok: true, bundles });
    await call("?q=seçim");
    expect(bundles.map((b) => b.cluster.id)).toEqual(["m1", "m2", "m3"]);
    expect(bundles.map((b) => b.cluster.article_count)).toEqual([2, 9, 5]);
  });

  it("a short hit list (fewer than the pool) is just shown newest first", async () => {
    searchClustersMock.mockResolvedValue({
      ok: true,
      bundles: [
        bundle({ id: "s1", articleCount: 9, firstPublished: day(1) }),
        bundle({ id: "s2", articleCount: 2, firstPublished: day(5) }),
      ],
    });
    const res = await call("?q=seçim");
    const ids = ((await res.json()) as { items: Row[] }).items.map((i) => i.id);
    expect(ids).toEqual(["s2", "s1"]);
  });

  it("konu path: no corroboration re-rank, the reader's order and the plain 10 cap", async () => {
    getTopicClustersMock.mockResolvedValue({
      bundles: Array.from({ length: 14 }, (_, i) =>
        bundle({ id: `k${i}`, articleCount: i === 13 ? 40 : 2, firstPublished: day(i) }),
      ),
      hasMore: false,
      page: 1,
    });
    const res = await call("?konu=ekonomi");
    const ids = ((await res.json()) as { items: Row[] }).items.map((i) => i.id);
    expect(ids).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"]);
  });

  it("gundem path: no corroboration re-rank, the hub's order and the plain 10 cap", async () => {
    getEntityHubMock.mockResolvedValue({
      bundles: Array.from({ length: 14 }, (_, i) =>
        bundle({ id: `g${i}`, articleCount: i === 13 ? 40 : 2, firstPublished: day(i) }),
      ),
      total: 14,
      asOfMs: 1,
    });
    const res = await call("?gundem=deva");
    const ids = ((await res.json()) as { items: Row[] }).items.map((i) => i.id);
    expect(ids).toEqual(["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"]);
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
