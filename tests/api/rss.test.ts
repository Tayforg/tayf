import { describe, it, expect, beforeEach, vi } from "vitest";

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
let mockMembers: Record<string, unknown> = {};
let memberLookupCalls: string[][] = [];
// Default mirrors production reality per the neutralizer-honesty audit:
// zero clusters have ever been neutralized, so the AI-disclosure sentence
// must be absent unless a test opts into a non-zero count.
let mockNeutralStatus: { neutralized: number; eligible: number } | null = {
  neutralized: 0,
  eligible: 0,
};

vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: vi.fn(async () => ({ bundles: mockBundles })),
}));

// Whole module mocked — it imports next/cache and its "use cache" body
// would throw outside a Next request context.
vi.mock("@/lib/clusters/rss-summary-attribution", () => ({
  getRssSummaryMembers: vi.fn(async (ids: string[]) => {
    memberLookupCalls.push(ids);
    return mockMembers;
  }),
}));

// Also "use cache" — same reason as above.
vi.mock("@/lib/headline/status", () => ({
  getNeutralizedStatus: vi.fn(async () => mockNeutralStatus),
}));

beforeEach(() => {
  mockBundles = [];
  mockMembers = {};
  memberLookupCalls = [];
  mockNeutralStatus = { neutralized: 0, eligible: 0 };
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
});
