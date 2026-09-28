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
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        fixture.lastClustersState = state;
        if (fixture.clustersError) {
          return { data: null, error: fixture.clustersError };
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
        if (fixture.sourcesError) {
          return { data: null, error: fixture.sourcesError };
        }
        return { data: fixture.sources, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  escapeXml,
  monthsBetween,
  parseSitemapFile,
  renderUrlset,
  renderNewsUrlset,
  renderSitemapIndex,
  getSitemapIndexXml,
  getStaticSitemapXml,
  getSourcesSitemapXml,
  getNewsSitemapXml,
  getClustersMonthXml,
  SITEMAP_FIRST_MONTH,
  NEWS_LIMIT,
} from "./sitemaps";
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

describe("getSitemapIndexXml", () => {
  it("lists the 3 fixed files plus every month through the current one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    try {
      return getSitemapIndexXml("https://tayf.test").then((xml) => {
        expect(xml).toContain("https://tayf.test/sitemaps/static.xml");
        expect(xml).toContain("https://tayf.test/sitemaps/sources.xml");
        expect(xml).toContain("https://tayf.test/sitemaps/news.xml");
        for (const m of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
          expect(xml).toContain(`https://tayf.test/sitemaps/clusters-${m}.xml`);
        }
        expect(xml).not.toContain("clusters-2026-10.xml");
      });
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
