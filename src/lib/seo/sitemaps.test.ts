import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// src/lib/seo/sitemaps.ts — pure helpers, months/parsing helpers, and the
// cached DB builders behind /sitemap.xml + /sitemaps/[file]. next/cache is
// mocked (no real cache runtime in vitest); Supabase is mocked via the
// shared chainable fake, same pattern as tests/api/sitemap.test.ts.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  clusters: [] as Array<Record<string, unknown>>,
  sources: [] as Array<Record<string, unknown>>,
  clustersError: null as { message: string } | null,
  sourcesError: null as { message: string } | null,
  lastClustersState: null as unknown,
  lastSourcesState: null as unknown,
  rangeCalls: [] as Array<{ from: number; to: number }>,
  // cached-failure-sweep: the first N reads of each table fail (a blip the
  // live retry can heal), a page-2 failure (no partial month), and a count of
  // supabase-js client builds (1 = no retry, 2 = attempt + one live retry).
  sourcesBlips: 0,
  clustersBlips: 0,
  clustersFailFromPage: null as number | null,
  clientBuilds: 0,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        fixture.lastClustersState = state;
        if (fixture.clustersBlips > 0) {
          fixture.clustersBlips -= 1;
          return { data: null, error: { message: "blip" } };
        }
        if (fixture.clustersError) {
          return { data: null, error: fixture.clustersError };
        }
        if (
          fixture.clustersFailFromPage !== null &&
          state.range &&
          state.range.from >= fixture.clustersFailFromPage * 1000
        ) {
          return { data: null, error: { message: "page boom" } };
        }
        if (state.range) {
          fixture.rangeCalls.push({ from: state.range.from, to: state.range.to });
          const page = fixture.clusters.slice(state.range.from, state.range.to + 1);
          return { data: page, error: null };
        }
        return { data: fixture.clusters, error: null };
      },
      sources: (state) => {
        fixture.lastSourcesState = state;
        if (fixture.sourcesBlips > 0) {
          fixture.sourcesBlips -= 1;
          return { data: null, error: { message: "blip" } };
        }
        if (fixture.sourcesError) {
          return { data: null, error: fixture.sourcesError };
        }
        return { data: fixture.sources, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    fixture.clientBuilds += 1;
    return supabaseFake.client;
  },
}));

import {
  escapeXml,
  monthsBetween,
  parseSitemapFile,
  renderUrlset,
  renderNewsUrlset,
  renderSitemapIndex,
  getSitemapIndexXml,
  getCurrentSitemapMonth,
  utcMonthKey,
  getStaticSitemapXml,
  getSourcesSitemapXml,
  getNewsSitemapXml,
  getClustersMonthXml,
  SITEMAP_FIRST_MONTH,
  NEWS_LIMIT,
} from "./sitemaps";
import { cacheLife } from "next/cache";
import { escapeXml as rssBuilderEscapeXml } from "@/lib/feeds/rss-builder";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fixture.clusters = [];
  fixture.sources = [];
  fixture.clustersError = null;
  fixture.sourcesError = null;
  fixture.lastClustersState = null;
  fixture.lastSourcesState = null;
  fixture.rangeCalls = [];
  fixture.sourcesBlips = 0;
  fixture.clustersBlips = 0;
  fixture.clustersFailFromPage = null;
  fixture.clientBuilds = 0;
  vi.mocked(cacheLife).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("escapeXml", () => {
  it("escapes the five XML-significant characters", () => {
    expect(escapeXml(`a & b < c > d ' e " f`)).toBe(
      "a &amp; b &lt; c &gt; d &apos; e &quot; f",
    );
  });

  it("strips XML-illegal control characters", () => {
    const withControls =
      "abc" +
      String.fromCharCode(0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f) +
      "def";
    expect(escapeXml(withControls)).toBe("abcdef");
  });

  it("keeps tab, newline and carriage return (legal XML whitespace)", () => {
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips the BMP non-characters U+FFFE and U+FFFF", () => {
    expect(escapeXml("x￾y￿z")).toBe("xyz");
  });

  it("strips lone surrogates but keeps a valid pair (emoji)", () => {
    expect(escapeXml("a\uD800b")).toBe("ab"); // lone high
    expect(escapeXml("a\uDC00b")).toBe("ab"); // lone low
    expect(escapeXml("a😀b")).toBe("a😀b");
  });

  it("is the shared RSS-builder escaper, not a second copy", () => {
    expect(escapeXml).toBe(rssBuilderEscapeXml);
  });
});

describe("monthsBetween", () => {
  it("lists months inclusively", () => {
    expect(monthsBetween("2026-04", "2026-07")).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("returns a single-element list when first equals last", () => {
    expect(monthsBetween("2026-04", "2026-04")).toEqual(["2026-04"]);
  });
});

describe("parseSitemapFile", () => {
  it("accepts the three fixed files", () => {
    expect(parseSitemapFile("static.xml")).toBe("static");
    expect(parseSitemapFile("sources.xml")).toBe("sources");
    expect(parseSitemapFile("news.xml")).toBe("news");
  });

  it("accepts hubs.xml, the sitemap of indexable /gundem/<key> hubs", () => {
    expect(parseSitemapFile("hubs.xml")).toBe("hubs");
  });

  it("accepts a valid month file at or after SITEMAP_FIRST_MONTH", () => {
    expect(parseSitemapFile("clusters-2026-09.xml")).toEqual({ month: "2026-09" });
    expect(parseSitemapFile(`clusters-${SITEMAP_FIRST_MONTH}.xml`)).toEqual({
      month: SITEMAP_FIRST_MONTH,
    });
  });

  it("rejects an invalid month number", () => {
    expect(parseSitemapFile("clusters-2026-13.xml")).toBeNull();
    expect(parseSitemapFile("clusters-2026-00.xml")).toBeNull();
  });

  it("rejects a month before SITEMAP_FIRST_MONTH", () => {
    expect(parseSitemapFile("clusters-2025-12.xml")).toBeNull();
  });

  it("rejects a path-traversal attempt", () => {
    expect(parseSitemapFile("../x")).toBeNull();
    expect(parseSitemapFile("../../etc/passwd")).toBeNull();
  });

  it("rejects a near-miss extension", () => {
    expect(parseSitemapFile("news.xml.gz")).toBeNull();
    expect(parseSitemapFile("newsxml")).toBeNull();
    expect(parseSitemapFile("hubs.xml.gz")).toBeNull();
    expect(parseSitemapFile("hubsxml")).toBeNull();
  });

  it("does not upper-bound a future month", () => {
    expect(parseSitemapFile("clusters-2099-01.xml")).toEqual({ month: "2099-01" });
  });
});

describe("renderUrlset", () => {
  it("renders loc/lastmod/changefreq/priority for each entry", () => {
    const xml = renderUrlset([
      { loc: "https://tayf.test/a", lastmod: "2026-04-18T11:00:00.000Z", changefreq: "hourly", priority: 0.8 },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>https://tayf.test/a</loc>");
    expect(xml).toContain("<lastmod>2026-04-18T11:00:00.000Z</lastmod>");
    expect(xml).toContain("<changefreq>hourly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
  });

  it("omits optional fields when absent", () => {
    const xml = renderUrlset([{ loc: "https://tayf.test/b" }]);
    expect(xml).toContain("<loc>https://tayf.test/b</loc>");
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("escapes a title-adjacent loc", () => {
    const xml = renderUrlset([{ loc: "https://tayf.test/a&b" }]);
    expect(xml).toContain("<loc>https://tayf.test/a&amp;b</loc>");
  });
});

describe("renderNewsUrlset", () => {
  it("declares the news namespace and escapes the title", () => {
    const xml = renderNewsUrlset([
      { loc: "https://tayf.test/cluster/1", title: "A & B", publishedAt: "2026-09-27T10:00:00.000Z" },
    ]);
    expect(xml).toContain('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"');
    expect(xml).toContain("<news:name>Tayf</news:name>");
    expect(xml).toContain("<news:language>tr</news:language>");
    expect(xml).toContain("<news:publication_date>2026-09-27T10:00:00.000Z</news:publication_date>");
    expect(xml).toContain("<news:title>A &amp; B</news:title>");
  });
});

describe("renderSitemapIndex", () => {
  it("lists every loc as a <sitemap> entry", () => {
    const xml = renderSitemapIndex(["https://tayf.test/a.xml", "https://tayf.test/b.xml"]);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain("<sitemap><loc>https://tayf.test/a.xml</loc></sitemap>");
    expect(xml).toContain("<sitemap><loc>https://tayf.test/b.xml</loc></sitemap>");
  });
});

describe("utcMonthKey", () => {
  it("formats an instant as its UTC YYYY-MM", () => {
    expect(utcMonthKey(Date.parse("2026-09-28T12:00:00.000Z"))).toBe("2026-09");
  });

  it("stays in December on the last UTC minute of the year", () => {
    expect(utcMonthKey(Date.parse("2026-12-31T23:59:00.000Z"))).toBe("2026-12");
  });

  it("stays in November on the last UTC minute of the month", () => {
    expect(utcMonthKey(Date.parse("2026-11-30T23:59:00.000Z"))).toBe("2026-11");
  });

  it("rolls over exactly at the UTC month boundary (not Istanbul's)", () => {
    // 21:00Z on the 31st is already the 1st in Europe/Istanbul (UTC+3);
    // the sitemap months are UTC, so it must still be the old month.
    expect(utcMonthKey(Date.parse("2026-10-31T21:00:00.000Z"))).toBe("2026-10");
    expect(utcMonthKey(Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
  });

  it("zero-pads single-digit months", () => {
    expect(utcMonthKey(Date.parse("2027-01-05T00:00:00.000Z"))).toBe("2027-01");
  });
});

describe("getCurrentSitemapMonth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current UTC month key and caches for an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:30:00.000Z"));
    vi.mocked(cacheLife).mockClear();

    await expect(getCurrentSitemapMonth()).resolves.toBe("2026-11");

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith({ revalidate: 3600 });
  });
});

describe("getSitemapIndexXml", () => {
  it("lists the 4 fixed files plus every month through the current one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    try {
      return getSitemapIndexXml("https://tayf.test").then((xml) => {
        expect(xml).toContain("https://tayf.test/sitemaps/static.xml");
        expect(xml).toContain("https://tayf.test/sitemaps/sources.xml");
        expect(xml).toContain("https://tayf.test/sitemaps/news.xml");
        expect(xml).toContain("https://tayf.test/sitemaps/hubs.xml");
        for (const m of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
          expect(xml).toContain(`https://tayf.test/sitemaps/clusters-${m}.xml`);
        }
        expect(xml).not.toContain("clusters-2026-10.xml");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds the new month as soon as the UTC month rolls over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T23:59:00.000Z"));
      const before = await getSitemapIndexXml("https://tayf.test");
      expect(before).toContain("clusters-2026-10.xml");
      expect(before).not.toContain("clusters-2026-11.xml");

      vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
      const after = await getSitemapIndexXml("https://tayf.test");
      expect(after).toContain("clusters-2026-11.xml");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getStaticSitemapXml", () => {
  it("lists /konu and every TOPIC_SLUGS hub, and never /konu/politika", async () => {
    const xml = await getStaticSitemapXml("https://tayf.test");
    expect(xml).toContain("<loc>https://tayf.test/konu</loc>");
    expect(xml).toContain("<loc>https://tayf.test/konu/dunya</loc>");
    expect(xml).not.toContain("/konu/politika");
  });

  it("lists the /gundem index right after /konu (daily, 0.5) but none of the /gundem/<key> hubs", async () => {
    const xml = await getStaticSitemapXml("https://tayf.test");
    expect(xml).toContain("<loc>https://tayf.test/gundem</loc>");
    const konu = xml.indexOf("<loc>https://tayf.test/konu</loc>");
    const gundem = xml.indexOf("<loc>https://tayf.test/gundem</loc>");
    expect(konu).toBeGreaterThan(-1);
    expect(gundem).toBeGreaterThan(konu);
    // the very next <url> after /konu is /gundem
    expect(xml.indexOf("<loc>", konu + 1)).toBe(gundem);
    const entry = xml.slice(gundem, xml.indexOf("</url>", gundem));
    expect(entry).toContain("<changefreq>daily</changefreq>");
    expect(entry).toContain("<priority>0.5</priority>");
    // Thin hubs are noindexed, so none of the 62 hubs is submitted.
    expect(xml).not.toContain("/gundem/");
    expect(xml.match(/<loc>[^<]*\/gundem[^<]*<\/loc>/g)).toHaveLength(1);
  });

  it("lists /durum (Sistem durumu) right after /kaynaklar/durum, hourly at priority 0.4", async () => {
    const xml = await getStaticSitemapXml("https://tayf.test");
    expect(xml).toContain("<loc>https://tayf.test/durum</loc>");
    const sourcesStatus = xml.indexOf("<loc>https://tayf.test/kaynaklar/durum</loc>");
    const status = xml.indexOf("<loc>https://tayf.test/durum</loc>");
    expect(sourcesStatus).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(sourcesStatus);
    // the very next <url> after /kaynaklar/durum is /durum
    expect(xml.indexOf("<loc>", sourcesStatus + 1)).toBe(status);
    const entry = xml.slice(status, xml.indexOf("</url>", status));
    expect(entry).toContain("<changefreq>hourly</changefreq>");
    expect(entry).toContain("<priority>0.4</priority>");
    // listed exactly once
    expect(xml.split("<loc>https://tayf.test/durum</loc>")).toHaveLength(2);
  });
});

describe("getSourcesSitemapXml", () => {
  it("emits one /source/<slug> per active source, filtered by active=true", async () => {
    fixture.sources = [
      { slug: "kaynak-a", active: true },
      { slug: "kaynak-b", active: true },
    ];
    const xml = await getSourcesSitemapXml("https://tayf.test");
    expect(xml).toContain("<loc>https://tayf.test/source/kaynak-a</loc>");
    expect(xml).toContain("<loc>https://tayf.test/source/kaynak-b</loc>");

    const state = fixture.lastSourcesState as BuilderState;
    expect(state.eq).toEqual([{ col: "active", val: true }]);
  });

  it("throws on a Supabase error instead of caching an empty sitemap", async () => {
    fixture.sourcesError = { message: "boom" };
    await expect(getSourcesSitemapXml("https://tayf.test")).rejects.toThrow(/boom/);
  });
});

describe("getNewsSitemapXml", () => {
  it("filters article_count >= 3, a 48h published window, and limits to 1000", async () => {
    fixture.clusters = [
      {
        id: "n1",
        title_tr: "Ham başlık",
        title_tr_neutral: "  ",
        first_published: "2026-09-27T10:00:00.000Z",
      },
      {
        id: "n2",
        title_tr: "İkinci başlık",
        title_tr_neutral: "Tarafsız başlık",
        first_published: "2026-09-27T11:00:00.000Z",
      },
    ];
    const xml = await getNewsSitemapXml("https://tayf.test");

    const state = fixture.lastClustersState as BuilderState;
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gte.find((f) => f.col === "article_count")).toEqual({
      col: "article_count",
      val: 3,
    });
    expect(state.gte.find((f) => f.col === "first_published")).toBeDefined();
    expect(state.lte.find((f) => f.col === "first_published")).toBeDefined();
    expect(state.limit).toBe(NEWS_LIMIT);

    // title fallback: blank neutral title falls back to title_tr.
    expect(xml).toContain("<news:title>Ham başlık</news:title>");
    expect(xml).toContain("<news:title>Tarafsız başlık</news:title>");
  });

  it("throws on a Supabase error instead of caching an empty sitemap", async () => {
    fixture.clustersError = { message: "db down" };
    await expect(getNewsSitemapXml("https://tayf.test")).rejects.toThrow(/db down/);
  });
});

describe("getClustersMonthXml", () => {
  it("pages through .range() until a short page, filtering is_archived/article_count/first_published", async () => {
    fixture.clusters = [
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `page1-${i}`,
        updated_at: "2026-09-01T00:00:00.000Z",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `page2-${i}`,
        updated_at: "2026-09-02T00:00:00.000Z",
      })),
    ];

    const xml = await getClustersMonthXml("https://tayf.test", "2026-09");

    expect(fixture.rangeCalls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
    const urlCount = (xml.match(/<url>/g) ?? []).length;
    expect(urlCount).toBe(1003);

    const state = fixture.lastClustersState as BuilderState;
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gte.find((f) => f.col === "article_count")).toEqual({
      col: "article_count",
      val: 2,
    });
    expect(state.gte.find((f) => f.col === "first_published")).toBeDefined();
    expect(state.lt.find((f) => f.col === "first_published")).toBeDefined();
  });

  it("throws on a Supabase error instead of caching an empty sitemap", async () => {
    fixture.clustersError = { message: "range boom" };
    await expect(getClustersMonthXml("https://tayf.test", "2026-09")).rejects.toThrow(
      /range boom/,
    );
  });
});

// ---------------------------------------------------------------------------
// cached-failure-sweep: the three DB-backed builders choose their cacheLife
// AFTER the read. A failed read is memoised for 'minutes' only, is retried
// live once per request (behind awaitRequestScope), and a still-failing retry
// REJECTS -- the sitemap route maps that to 503 no-store. It is never rendered
// as an empty <urlset>, which would de-index a month or the news feed.
// ---------------------------------------------------------------------------

describe("cached-failure-sweep: DB sitemap builders", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  const BASE = "https://tayf.test";
  const BUILDERS = [
    {
      name: "getSourcesSitemapXml",
      build: () => getSourcesSitemapXml(BASE),
      profile: { revalidate: 3600 },
      fail: () => {
        fixture.sourcesError = { message: "sources down" };
      },
      blip: () => {
        fixture.sourcesBlips = 1;
        fixture.sources = [{ slug: "kaynak-a", active: true }];
      },
      healed: "<loc>https://tayf.test/source/kaynak-a</loc>",
    },
    {
      name: "getNewsSitemapXml",
      build: () => getNewsSitemapXml(BASE),
      profile: { revalidate: 600 },
      fail: () => {
        fixture.clustersError = { message: "clusters down" };
      },
      blip: () => {
        fixture.clustersBlips = 1;
        fixture.clusters = [
          { id: "n1", title_tr: "Başlık", title_tr_neutral: null, first_published: "2026-09-27T10:00:00.000Z" },
        ];
      },
      healed: "<news:title>Başlık</news:title>",
    },
    {
      name: "getClustersMonthXml",
      build: () => getClustersMonthXml(BASE, "2026-09"),
      profile: { revalidate: 3600 },
      fail: () => {
        fixture.clustersError = { message: "clusters down" };
      },
      blip: () => {
        fixture.clustersBlips = 1;
        fixture.clusters = [{ id: "c1", updated_at: "2026-09-02T00:00:00.000Z" }];
      },
      healed: "<loc>https://tayf.test/cluster/c1</loc>",
    },
  ] as const;

  it.each(BUILDERS)(
    "$name: a failing read rejects after one live retry, never resolving to a urlset; the failure is cached for 'minutes'",
    async ({ build, fail }) => {
      fail();

      let resolved: string | null = null;
      await expect(
        build().then((xml) => {
          resolved = xml;
          return xml;
        }),
      ).rejects.toThrow(/down/);

      expect(resolved).toBeNull();
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
      expect(cacheLife).not.toHaveBeenCalledWith(expect.objectContaining({ revalidate: expect.anything() }));
      // The cached attempt + exactly one live retry.
      expect(fixture.clientBuilds).toBe(2);
    },
  );

  it.each(BUILDERS)(
    "$name: a blip on the cached attempt is healed by the live retry (real urlset), cached for 'minutes' only",
    async ({ build, blip, healed }) => {
      blip();

      const xml = await build();

      expect(xml).toContain("<urlset");
      expect(xml).toContain(healed);
      expect(fixture.clientBuilds).toBe(2);
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
    },
  );

  it.each(BUILDERS)(
    "$name: a successful read keeps its revalidate profile and builds one client",
    async ({ build, profile }) => {
      const xml = await build();

      expect(xml).toContain("<urlset");
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith(profile);
      expect(fixture.clientBuilds).toBe(1);
    },
  );

  it("a legitimately empty result is a success: an empty urlset cached for the full window", async () => {
    fixture.sources = [];
    const xml = await getSourcesSitemapXml(BASE);
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
    expect(cacheLife).toHaveBeenCalledWith({ revalidate: 3600 });
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
  });

  it("getClustersMonthXml never serves a partial month: a page-2 failure rejects the whole build", async () => {
    fixture.clusters = Array.from({ length: 1000 }, (_, i) => ({
      id: `p1-${i}`,
      updated_at: "2026-09-01T00:00:00.000Z",
    }));
    fixture.clustersFailFromPage = 1;

    await expect(getClustersMonthXml(BASE, "2026-09")).rejects.toThrow(/page boom/);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

describe("cached-failure-sweep: the pure builders are unchanged", () => {
  it("getStaticSitemapXml and getSitemapIndexXml build no client and keep one revalidate:3600", async () => {
    await getStaticSitemapXml("https://tayf.test");
    await getSitemapIndexXml("https://tayf.test");
    expect(fixture.clientBuilds).toBe(0);
    expect(cacheLife).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cacheLife).mock.calls).toEqual([[{ revalidate: 3600 }], [{ revalidate: 3600 }]]);
  });
});
