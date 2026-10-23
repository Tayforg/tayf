import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { miniParseRss } from "../_helpers/mini-rss-parse";

// ---------------------------------------------------------------------------
// GET /rss.xml
//
// Covers three things:
//   1. The channel-level AI-disclosure sentence — now conditional on
//      getNeutralizedStatus() actually reporting a non-zero neutralized
//      count, instead of an unconditional claim (Pack B: neutralizer
//      honesty). See src/lib/headline/status.ts.
//   2. The channel-level source-count wording carries no hardcoded number
//      (e.g. no stale "144 Türk kaynağından").
//   3. Per-item summary attribution: clusters.summary_tr is one outlet's
//      raw copy, not Tayf's — it must be attributed to that outlet, shown
//      generically, or hidden, never spliced in unattributed. See
//      src/lib/clusters/summary-attribution.ts and rss-summary-attribution.ts.
//
// Mock state is held in module-level `let` bindings (not vi.mocked() on the
// imported symbols) so fixtures stay plain, loosely-typed objects — the
// route only reads a handful of fields off each, matching the looseness of
// the pre-existing channel-description test.
// ---------------------------------------------------------------------------

let mockBundles: unknown[] = [];
// Set to make the cluster read reject / the summary-member read throw.
let mockPoliticsError: Error | null = null;
let mockMembersError: Error | null = null;
let mockMembers: Record<string, unknown> = {};
let mockMemberLookupFailed = false;
let memberLookupCalls: string[][] = [];
let memberLookupOpts: unknown[] = [];
// Default mirrors production reality per the neutralizer-honesty audit:
// zero clusters have ever been neutralized, so the AI-disclosure sentence
// must be absent unless a test opts into a non-zero count.
let mockNeutralStatus: { neutralized: number; eligible: number } | null = {
  neutralized: 0,
  eligible: 0,
};

// `connection()` throws outside a request scope; the route awaits it first so
// a 503 is never prerendered at build. Same mock as rss-topic.test.ts, but a
// spy so the ordering contract (connection before any read) is assertable.
const callOrder: string[] = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {
      callOrder.push("connection");
    },
  };
});

vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: vi.fn(async () => {
    callOrder.push("getPoliticsClusters");
    if (mockPoliticsError) throw mockPoliticsError;
    return { bundles: mockBundles };
  }),
}));

// Whole module mocked — it imports next/cache and its "use cache" body
// would throw outside a Next request context.
vi.mock("@/lib/clusters/rss-summary-attribution", () => ({
  getRssSummaryMembers: vi.fn(async (ids: string[], opts?: unknown) => {
    if (mockMembersError) throw mockMembersError;
    memberLookupCalls.push(ids);
    memberLookupOpts.push(opts);
    return { members: mockMembers, lookupFailed: mockMemberLookupFailed };
  }),
}));

// Also "use cache" — same reason as above.
vi.mock("@/lib/headline/status", () => ({
  getNeutralizedStatus: vi.fn(async () => mockNeutralStatus),
}));

beforeEach(() => {
  mockBundles = [];
  mockPoliticsError = null;
  mockMembersError = null;
  callOrder.length = 0;
  mockMembers = {};
  mockMemberLookupFailed = false;
  memberLookupCalls = [];
  memberLookupOpts = [];
  mockNeutralStatus = { neutralized: 0, eligible: 0 };
});

let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = null;
});

const T0 = "2026-04-17T08:00:00.000Z";
const T1 = "2026-04-17T08:05:00.000Z";
const T2 = "2026-04-17T08:10:00.000Z";

function bundle(opts: {
  id: string;
  summary: string;
  articleCount: number;
  effectiveArticleCount: number;
  isWireRedistribution: boolean;
}) {
  return {
    cluster: {
      id: opts.id,
      title_tr: `Başlık ${opts.id}`,
      summary_tr: opts.summary,
      article_count: opts.articleCount,
      first_published: T0,
    },
    articles: [],
    sources: [],
    effectiveArticleCount: opts.effectiveArticleCount,
    isWireRedistribution: opts.isWireRedistribution,
  };
}

function member(
  name: string,
  publishedAt: string,
  description: string | null,
  contentHash: string | null = null,
) {
  return {
    source: { name, bias: "center" },
    article: { published_at: publishedAt, content_hash: contentHash, description },
  };
}

function parseItems(xml: string): Array<{ link: string; description: string }> {
  const items: Array<{ link: string; description: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml))) {
    const block = m[1] ?? "";
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? "";
    const description = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? "";
    items.push({ link, description });
  }
  return items;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("GET /rss.xml", () => {
  function singleClusterBundle() {
    mockBundles = [
      {
        cluster: {
          id: "cluster-1",
          title_tr: "Örnek başlık",
          summary_tr: "Örnek özet",
          article_count: 3,
          first_published: "2026-04-17T08:00:00Z",
        },
        articles: [],
        sources: [],
      },
    ];
    mockMembers = {};
  }

  it("sets Cache-Control with stale-while-revalidate (F2)", async () => {
    singleClusterBundle();
    mockNeutralStatus = { neutralized: 0, eligible: 10 };

    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
    );
  });

  it("omits the AI-disclosure sentence and any hardcoded source count while neutralized is 0", async () => {
    singleClusterBundle();
    mockNeutralStatus = { neutralized: 0, eligible: 10 };

    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();
    const xml = await res.text();

    expect(xml).not.toContain("tarafsızlaştır");
    expect(xml).not.toContain("144");

    // Still lives inside the channel-level <description>, not an <item>.
    const channelDescMatch = xml.match(
      /<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/,
    );
    expect(channelDescMatch).not.toBeNull();
    expect(channelDescMatch![1]).not.toContain("tarafsızlaştır");
    expect(channelDescMatch![1]).not.toContain("144");
  });

  it("appends the AI-disclosure sentence to the channel description exactly once once neutralized > 0", async () => {
    singleClusterBundle();
    mockNeutralStatus = { neutralized: 3, eligible: 10 };

    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();
    const xml = await res.text();

    const sentence =
      "Başlıklar yapay zekâ ile tarafsızlaştırılmıştır (tayfhaber.com/metodoloji).";

    const occurrences = xml.split(sentence).length - 1;
    expect(occurrences).toBe(1);
    expect(xml).not.toContain("144");

    // Must live inside the channel-level <description>, not an <item>.
    const channelDescMatch = xml.match(
      /<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/,
    );
    expect(channelDescMatch).not.toBeNull();
    expect(channelDescMatch![1]).toContain(sentence);
  });

  it("omits the AI-disclosure sentence when getNeutralizedStatus() returns null (unknown status)", async () => {
    singleClusterBundle();
    mockNeutralStatus = null;

    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();
    const xml = await res.text();

    expect(xml).not.toContain("tarafsızlaştır");
  });

  it("attributes, hides, or degrades item summaries per cluster, and looks up members only for non-blank summaries", async () => {
    mockBundles = [
      bundle({ id: "c1", summary: "AA metni", articleCount: 3, effectiveArticleCount: 3, isWireRedistribution: false }),
      bundle({ id: "c2", summary: "Kopya metin", articleCount: 5, effectiveArticleCount: 1, isWireRedistribution: true }),
      bundle({ id: "c3", summary: "Eşleşmeyen özet", articleCount: 3, effectiveArticleCount: 3, isWireRedistribution: false }),
      bundle({ id: "c4", summary: "Bilinmeyen özet", articleCount: 5, effectiveArticleCount: 1, isWireRedistribution: true }),
      bundle({ id: "c5", summary: "", articleCount: 2, effectiveArticleCount: 2, isWireRedistribution: false }),
    ];
    mockMembers = {
      // c1: seed matches the summary text exactly -> named-outlet attribution.
      c1: [member("Anadolu Ajansı", T0, "AA metni", "h-c1")],
      // c2: all 3 members share content_hash -> wire majority hides the summary.
      c2: [
        member("AA", T0, "Kopya metin", "h1"),
        member("Kaynak B", T1, null, "h1"),
        member("Kaynak C", T2, null, "h1"),
      ],
      // c3: no member description matches -> generic "Kaynak açıklaması" fallback.
      c3: [
        member("Kaynak D", T0, "Farklı metin 1"),
        member("Kaynak E", T1, "Farklı metin 2"),
        member("Kaynak F", T2, "Farklı metin 3"),
      ],
      // c4 deliberately has no key: degraded lookup, wire -> hidden wholesale.
    };

    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();
    const items = parseItems(xml);
    const byId = (id: string) => {
      const item = items.find((i) => i.link.endsWith(`/cluster/${id}`));
      if (!item) throw new Error(`no item for cluster ${id}`);
      return item;
    };

    expect(byId("c1").description).toBe("3 kaynaktan haberler. Anadolu Ajansı: AA metni");
    expect(byId("c1").description).not.toContain("Kaynak açıklaması");

    expect(byId("c2").description).toBe("1 kaynaktan haberler. Tek kaynaktan 5 kopya.");
    expect(byId("c2").description).not.toContain("Kopya metin");

    expect(byId("c3").description).toBe("3 kaynaktan haberler. Kaynak açıklaması: Eşleşmeyen özet");

    expect(byId("c4").description).not.toContain("Bilinmeyen özet");

    expect(byId("c5").description).toBe("2 kaynaktan haberler.");
    expect(byId("c5").description).not.toMatch(/\s$/);

    // Blank-summary clusters are excluded from the batched lookup.
    expect(memberLookupCalls).toEqual([["c1", "c2", "c3", "c4"]]);

    // Honesty invariant: raw summary text never appears without an
    // attribution label (named outlet, or the generic fallback).
    for (const b of mockBundles as ReturnType<typeof bundle>[]) {
      const text = b.cluster.summary_tr.trim();
      if (text.length === 0) continue;
      const desc = byId(b.cluster.id).description;
      if (desc.includes(text)) {
        expect(desc).toMatch(new RegExp(`: ${escapeRegExp(text)}$`));
      }
    }
  });

  it("escapes & and < in the composed description and never leaks raw XML-unsafe characters", async () => {
    mockBundles = [
      bundle({
        id: "esc1",
        summary: "Ekonomi & Siyaset < gündem metni",
        articleCount: 2,
        effectiveArticleCount: 2,
        isWireRedistribution: false,
      }),
    ];
    mockMembers = {
      esc1: [member("A&B <Haber>", T0, "Ekonomi & Siyaset < gündem metni")],
    };

    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();
    const desc = parseItems(xml)[0]!.description;

    expect(desc).toContain("&amp;");
    expect(desc).toContain("&lt;");
    expect(desc).not.toContain("<");
    // No stray "&" outside a known entity.
    expect(desc.replace(/&(amp|lt|gt|quot|apos);/g, "")).not.toContain("&");
  });

  it("truncates a long summary to at most 400 chars on a word boundary, ending in an ellipsis", async () => {
    const longText = "kelime ".repeat(100).trim(); // 699 chars, no XML-special chars
    expect(longText.length).toBeGreaterThan(600);
    mockBundles = [
      bundle({ id: "trunc1", summary: longText, articleCount: 4, effectiveArticleCount: 4, isWireRedistribution: false }),
    ];
    mockMembers = { trunc1: [member("Uzun Kaynak", T0, longText)] };

    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();
    const desc = parseItems(xml)[0]!.description;

    expect(desc.length).toBeLessThanOrEqual(400);
    expect(desc.endsWith("…")).toBe(true);
  });

  describe("BL-13 fail-closed on a failed member lookup", () => {
    it("omits the summary text for every cluster when getRssSummaryMembers reports lookupFailed, even for text an allowed member would show", async () => {
      mockBundles = [
        bundle({ id: "fail1", summary: "AA metni", articleCount: 3, effectiveArticleCount: 3, isWireRedistribution: false }),
      ];
      // No entry for fail1 at all — mirrors what a real failed lookup
      // returns (an empty members map) — but flagged as a failure.
      mockMembers = {};
      mockMemberLookupFailed = true;

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();
      const desc = parseItems(xml)[0]!.description;

      expect(desc).not.toContain("AA metni");
      expect(desc).toBe("3 kaynaktan haberler.");
    });

    it("control: renders the attributed summary when the lookup succeeds (lookupFailed: false) with an allowed member", async () => {
      mockBundles = [
        bundle({ id: "ok1", summary: "AA metni", articleCount: 3, effectiveArticleCount: 3, isWireRedistribution: false }),
      ];
      mockMembers = { ok1: [member("Anadolu Ajansı", T0, "AA metni")] };
      mockMemberLookupFailed = false;

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();
      const desc = parseItems(xml)[0]!.description;

      expect(desc).toBe("3 kaynaktan haberler. Anadolu Ajansı: AA metni");
    });
  });
});

describe("GET /rss.xml summary-member lookup read profile", () => {
  it("stays on the default capped reader profile (only the digest cron opts into batch)", async () => {
    mockBundles = [
      bundle({
        id: "c1",
        summary: "Metin",
        articleCount: 3,
        effectiveArticleCount: 3,
        isWireRedistribution: false,
      }),
    ];
    const { GET } = await import("@/app/rss.xml/route");
    await GET();
    expect(memberLookupCalls).toEqual([["c1"]]);
    const opts = memberLookupOpts[0] as { profile?: string } | undefined;
    expect(opts?.profile ?? "reader").toBe("reader");
  });
});


describe("GET /rss.xml hardening", () => {
  function titled(id: string, title: string, firstPublished = T0) {
    return {
      cluster: {
        id,
        title_tr: title,
        summary_tr: "",
        article_count: 3,
        first_published: firstPublished,
      },
      articles: [],
      sources: [],
      effectiveArticleCount: 3,
      isWireRedistribution: false,
    };
  }

  // Characters XML 1.0 forbids: C0 control, the BMP non-characters, a lone
  // high surrogate. One of these in one feed-sourced title breaks the feed
  // for every subscriber.
  const ILLEGAL_XML_RE =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("strips XML-illegal characters from a title and the feed still parses", async () => {
    mockBundles = [
      titled("bad1", "Kötü\u000B başlık\uFFFE sonu\uD800"),
      titled("ok1", "Temiz başlık"),
    ];

    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const xml = await res.text();

    expect(ILLEGAL_XML_RE.test(xml)).toBe(false);
    expect(xml).not.toContain("\u000B");
    expect(xml).not.toContain("\uFFFE");
    expect(xml).not.toContain("\uD800");

    const parsed = miniParseRss(xml) as {
      rss: { channel: { item: Array<{ title: string }> } };
    };
    expect(parsed.rss.channel.item.map((i) => i.title)).toEqual([
      "Kötü başlık sonu",
      "Temiz başlık",
    ]);
  });

  it("escapes entities in a title exactly once (no double escaping)", async () => {
    mockBundles = [titled("amp1", "Tom & Jerry <canlı>")];

    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();

    expect(xml).toContain("<title>Tom &amp; Jerry &lt;canlı&gt;</title>");
    expect(xml).not.toContain("&amp;amp;");
  });

  it("falls back to 'Başlıksız' for a cluster without a title", async () => {
    mockBundles = [titled("nt1", "x")];
    (mockBundles[0] as { cluster: { title_tr: string | null } }).cluster.title_tr = null;

    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();

    expect(xml).toContain("<title>Başlıksız</title>");
  });

  describe("503 failure path", () => {
    function expectUnavailable(res: Response) {
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("300");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    }

    it("returns 503 (never a cached empty feed) when getPoliticsClusters rejects", async () => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPoliticsError = new Error("reader timeout");

      const { GET } = await import("@/app/rss.xml/route");
      const res = await GET();

      expectUnavailable(res);
      expect(await res.text()).toBe("Service unavailable");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[rss.xml] unavailable: reader timeout",
      );
    });

    it("returns the same 503 when getRssSummaryMembers throws", async () => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockBundles = [
        bundle({
          id: "m1",
          summary: "Özet",
          articleCount: 3,
          effectiveArticleCount: 3,
          isWireRedistribution: false,
        }),
      ];
      mockMembersError = new Error("members boom");

      const { GET } = await import("@/app/rss.xml/route");
      const res = await GET();

      expectUnavailable(res);
      expect(await res.text()).toBe("Service unavailable");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[rss.xml] unavailable: members boom",
      );
    });

    it("logs a non-Error rejection without crashing the handler", async () => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPoliticsError = "plain string" as unknown as Error;

      const { GET } = await import("@/app/rss.xml/route");
      const res = await GET();

      expectUnavailable(res);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[rss.xml] unavailable: plain string",
      );
    });

    it("awaits connection() before any read, so a 503 is never prerendered at build", async () => {
      mockBundles = [titled("c1", "Başlık")];

      const { GET } = await import("@/app/rss.xml/route");
      await GET();

      expect(callOrder[0]).toBe("connection");
      expect(callOrder.indexOf("connection")).toBeLessThan(
        callOrder.indexOf("getPoliticsClusters"),
      );
    });
  });

  describe("absolute links use siteUrl()", () => {
    it("prefixes channel link, self link, item link and guid with NEXT_PUBLIC_SITE_URL", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
      mockBundles = [titled("link1", "Başlık")];

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();

      expect(xml).toContain("<link>https://example.test/</link>");
      expect(xml).toContain(
        '<atom:link href="https://example.test/rss.xml" rel="self" type="application/rss+xml" />',
      );
      expect(xml).toContain("<link>https://example.test/cluster/link1</link>");
      expect(xml).toContain(
        '<guid isPermaLink="true">https://example.test/cluster/link1</guid>',
      );
    });

    it("falls back to the Vercel production host when NEXT_PUBLIC_SITE_URL is unset (siteUrl() chain)", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
      vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "prod.example.test");
      mockBundles = [titled("link2", "Başlık")];

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();

      expect(xml).toContain("<link>https://prod.example.test/cluster/link2</link>");
    });
  });

  describe("success response", () => {
    it("keeps the public + stale-while-revalidate Cache-Control and the RSS content type", async () => {
      mockBundles = [titled("h1", "Başlık")];

      const { GET } = await import("@/app/rss.xml/route");
      const res = await GET();

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
      );
      expect(res.headers.get("Content-Type")).toBe(
        "application/rss+xml; charset=utf-8",
      );
    });

    it("lastBuildDate is the newest item's pubDate, never the request time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2031-01-02T03:04:05Z"));
      mockBundles = [
        titled("old", "Eski", "2026-04-17T08:00:00.000Z"),
        titled("new", "Yeni", "2026-04-19T09:30:00.000Z"),
        titled("mid", "Orta", "2026-04-18T10:00:00.000Z"),
      ];

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();

      const newest = new Date("2026-04-19T09:30:00.000Z").toUTCString();
      expect(xml).toContain(`<lastBuildDate>${newest}</lastBuildDate>`);
      expect(xml).not.toContain("2031");
    });

    it("serves a valid empty feed with no lastBuildDate when there are no clusters", async () => {
      mockBundles = [];

      const { GET } = await import("@/app/rss.xml/route");
      const res = await GET();
      const xml = await res.text();

      expect(res.status).toBe(200);
      expect(xml).toContain("<channel>");
      expect(xml).not.toContain("<lastBuildDate>");
      expect(xml).not.toContain("<item>");
    });

    it("keeps the channel title, language and the 30-item cap", async () => {
      mockBundles = Array.from({ length: 35 }, (_, i) =>
        titled(`n${i}`, `Başlık ${i}`),
      );

      const { GET } = await import("@/app/rss.xml/route");
      const xml = await (await GET()).text();

      expect(xml).toContain("<title>Tayf — Türkiye Haber Analizi</title>");
      expect(xml).toContain("<language>tr-TR</language>");
      expect(parseItems(xml)).toHaveLength(30);
    });
  });
});
