import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { BiasDistribution, Source } from "@/types";
import { FramingComparison } from "@/components/story/framing-comparison";
import { MediaDna } from "@/components/story/media-dna";
import { StoryTimeline } from "@/components/story/story-timeline";
import { FactCheckBox } from "@/components/story/fact-check-box";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// @/lib/clusters/cluster-detail-query: the whole point. `getClusterDetail`
// is replaced with a `vi.fn()` so each test controls exactly what
// `ClusterDetailPage` sees without a real Supabase round-trip.
// `imageEligibleMembers` (the BL-13 hero-image gate the page now imports
// instead of re-implementing inline) is kept REAL via `importOriginal` —
// otherwise the page's `imageEligibleMembers(members)` call would blow up
// on an undefined export. Type-only imports of `ClusterDetail`/
// `ClusterDetailMember` from this same specifier (used by framing.ts,
// read-across.ts, ownership-line.tsx, etc.) are erased at compile time, so
// mocking the runtime export here doesn't touch them.
//
// next/navigation: `notFound()` is imported by the page but never invoked
// in these fixtures (every fixture resolves to a non-null detail) — mocked
// anyway per the worker brief so importing it never depends on a live
// Next.js request context.
const getClusterDetail = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/cluster-detail-query")>();
  return {
    ...actual,
    getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
  };
});
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));
// Story timeline ("Kim önce yazdı?"): the created_at lookup and the per-zone
// feed health are both Supabase-backed — mocked so the page never reaches a
// real client. Defaults (null = unknown/fail-open) are set in beforeEach.
const getMemberSeenAt = vi.fn();
vi.mock("@/lib/clusters/story-timeline-query", () => ({
  getMemberSeenAt: (...args: unknown[]) => getMemberSeenAt(...args),
}));
const getZoneFeedHealth = vi.fn();
vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: (...args: unknown[]) => getZoneFeedHealth(...args),
  };
});
// "Bu konuda doğrulama" fact-check box: Supabase-backed lookup, mocked so
// the page never reaches a real client. Defaults to [] (no box) below.
const getClusterFactChecks = vi.fn();
vi.mock("@/lib/fact-checks/cluster-fact-checks-query", () => ({
  getClusterFactChecks: (...args: unknown[]) => getClusterFactChecks(...args),
}));

import ClusterDetailPage, { generateMetadata } from "./page";

/** Collects every string/number leaf under a React element tree. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/** True if any element in the tree has the given component type. */
function hasElementOfType(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((c) => hasElementOfType(c, type));
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === type) return true;
    if (el.props?.children !== undefined) return hasElementOfType(el.props.children, type);
  }
  return false;
}

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

/**
 * Finds the first element in the tree that carries a `credits` prop (i.e.
 * the `<ClusterCardImage>` element) and returns that prop. R1-F1 moved the
 * hero credit line into the client component, keyed by image URL, so it
 * always names the outlet whose photo is actually on screen — this walker
 * reads the prop the server passed down rather than rendered text, since
 * `ClusterCardImage` itself ("use client") isn't expanded in this
 * server-side element tree.
 */
function findCredits(
  node: unknown,
): Record<string, { href: string; name: string }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findCredits(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: { credits?: unknown; children?: ReactNode };
    };
    if (el.props?.credits !== undefined) {
      return el.props.credits as Record<string, { href: string; name: string }>;
    }
    if (el.props?.children !== undefined) {
      return findCredits(el.props.children);
    }
  }
  return undefined;
}

/**
 * Like `findCredits` but returns the `src` prop of the same element (the
 * `<ClusterCardImage>` element carries both) — used to assert which image
 * (if any) was chosen as the hero, e.g. that a BL-13-blocked source's
 * photo was never selected.
 */
function findHeroSrc(node: unknown): string | null | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHeroSrc(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: { credits?: unknown; src?: string | null; children?: ReactNode };
    };
    if (el.props?.credits !== undefined) {
      return el.props.src ?? null;
    }
    if (el.props?.children !== undefined) {
      return findHeroSrc(el.props.children);
    }
  }
  return undefined;
}

/**
 * Walks the tree (same shape as `collectHrefs`) looking for the
 * `<script type="application/ld+json">` element and returns its
 * `dangerouslySetInnerHTML.__html` string, or `null` if none is found.
 */
function findJsonLd(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonLd(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: {
        type?: unknown;
        dangerouslySetInnerHTML?: { __html?: unknown };
        children?: ReactNode;
      };
    };
    if (
      el.props?.type === "application/ld+json" &&
      typeof el.props.dangerouslySetInnerHTML?.__html === "string"
    ) {
      return el.props.dangerouslySetInnerHTML.__html;
    }
    if (el.props?.children !== undefined) {
      const found = findJsonLd(el.props.children);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Collects every heading tag (h1..h6) reachable from the page tree, in
 * document order — for the react-1 outline check. Calling a Server
 * Component function directly (as `ClusterDetailPage` is called throughout
 * this file) leaves nested custom components unexpanded in the returned
 * element tree, so the two components on this page that can carry a
 * heading are special-cased: `FramingComparison` is a plain, hookless
 * function — safe to call directly and recurse into its return value.
 * `MediaDna` is a "use client" component that calls `useState`, so it's
 * rendered through `renderToStaticMarkup` instead, which provides the real
 * hook dispatcher a direct call would lack.
 */
function collectHeadings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHeadings(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (typeof el.type === "string" && /^h[1-6]$/.test(el.type)) {
      out.push(el.type);
    }
    if (el.type === FramingComparison) {
      const rendered = (FramingComparison as (props: unknown) => ReactNode)(
        el.props,
      );
      collectHeadings(rendered, out);
      return out;
    }
    if (el.type === MediaDna) {
      const markup = renderToStaticMarkup(
        node as Parameters<typeof renderToStaticMarkup>[0],
      );
      for (const m of markup.match(/<h[1-6]\b/g) ?? []) out.push(m.slice(1));
      return out;
    }
    if (el.props?.children !== undefined) collectHeadings(el.props.children, out);
  }
  return out;
}

function emptyDistribution(): BiasDistribution {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    center: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
    islamist_conservative: 0,
    pro_kurdish: 0,
    international: 0,
  };
}

function makeSource(overrides: Partial<Source> & { id: string }): Source {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    slug: overrides.slug ?? overrides.id,
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    rss_url: overrides.rss_url ?? `https://example.com/${overrides.id}/rss`,
    bias: overrides.bias ?? "center",
    logo_url: overrides.logo_url ?? null,
    active: overrides.active ?? true,
    kind: overrides.kind,
    image_allowed: overrides.image_allowed,
    trustee_since: overrides.trustee_since ?? null,
    trustee_note: overrides.trustee_note ?? null,
  };
}

function makeMember(
  id: string,
  source: Source,
  publishedAt = "2026-09-06T12:00:00.000Z",
  imageUrl: string | null = null,
): ClusterDetailMember {
  return {
    source,
    article: {
      id,
      title: `${source.name} başlığı`,
      url: `https://example.com/articles/${id}`,
      published_at: publishedAt,
      image_url: imageUrl,
      content_hash: `hash-${id}`,
    },
  };
}

function makeCluster(overrides: {
  bias_distribution: BiasDistribution;
  is_archived?: boolean;
  title_original?: string | null;
  title_method?: ClusterDetail["cluster"]["title_method"];
}): ClusterDetail["cluster"] {
  return {
    id: "c1",
    title_tr: "Test kümesi",
    title_original: overrides.title_original ?? null,
    title_method: overrides.title_method ?? null,
    summary_tr: "Test özeti",
    article_count: 3,
    bias_distribution: overrides.bias_distribution,
    is_blindspot: false,
    blindspot_side: null,
    first_published: "2026-09-06T10:00:00.000Z",
    updated_at: "2026-09-06T12:00:00.000Z",
    is_archived: overrides.is_archived ?? false,
  };
}

// jsonLd's `image` field is `${siteUrl()}/cluster/${id}/opengraph-image` —
// siteUrl() reads NEXT_PUBLIC_SITE_URL, so pin it for a deterministic
// assertion below (mirrors the save/restore style in tests/api/sitemap.test.ts).
const ORIGINAL_SITE_URL_ENV = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
  getMemberSeenAt.mockReset();
  getMemberSeenAt.mockResolvedValue(null);
  getZoneFeedHealth.mockReset();
  getZoneFeedHealth.mockResolvedValue(null);
  getClusterFactChecks.mockReset();
  getClusterFactChecks.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_SITE_URL_ENV === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL_ENV;
});

describe("ClusterDetailPage — source-kind UI", () => {
  it("shows the non-voting row, the spectrum caption and kind labels for a mixed cluster", async () => {
    const outlet = makeSource({
      id: "s-outlet",
      slug: "s-outlet",
      name: "Outlet Gazete",
      bias: "pro_government",
      kind: "outlet",
    });
    const wire = makeSource({
      id: "s-wire",
      slug: "s-wire",
      name: "Wire Ajans",
      bias: "state_media",
      kind: "wire",
    });
    const aggregator = makeSource({
      id: "s-aggregator",
      slug: "s-aggregator",
      name: "Haberler.com",
      bias: "center",
      kind: "aggregator",
    });

    const members: ClusterDetailMember[] = [
      makeMember("a-outlet", outlet),
      makeMember("a-wire", wire),
      makeMember("a-aggregator", aggregator),
    ];

    const distribution = emptyDistribution();
    distribution.pro_government = 1;
    distribution.state_media = 1;

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: [outlet, wire, aggregator],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 3,
        memberCount: 3,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Toplayıcı / niş kaynaklar");
    expect(text).toContain("1 kaynak · spektruma sayılmaz");
    expect(text).toContain(
      "Spektrum 2 sınıflandırılmış kaynaktan oluşturuldu · 1 toplayıcı / niş kaynak sayılmadı",
    );
    expect(text).toContain("Haberler.com");
    expect(text).toContain("Toplayıcı");
    expect(hrefs).toContain("/metodoloji#kaynaklar");
    expect(hasElementOfType(tree, FramingComparison)).toBe(true);
  });

  it("shows the zero-vote fallback when every member is non-voting", async () => {
    const aggregator = makeSource({
      id: "s-aggregator",
      slug: "s-aggregator",
      name: "Haberler.com",
      bias: "center",
      kind: "aggregator",
    });

    const members: ClusterDetailMember[] = [makeMember("a-aggregator", aggregator)];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [aggregator],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 1,
        memberCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).toContain(
      "Bu kümede sınıflandırılan kaynak yok — yalnızca toplayıcı / niş kaynaklar yazdı",
    );
    expect(hasElementOfType(tree, FramingComparison)).toBe(false);
  });

  it("keeps the caption neutral when the stored distribution predates 034", async () => {
    const outlet = makeSource({
      id: "a-outlet",
      slug: "a-outlet",
      name: "Outlet Gazete",
      bias: "pro_government",
      kind: "outlet",
    });
    const aggregator = makeSource({
      id: "a-aggregator",
      slug: "a-aggregator",
      name: "Haberler.com",
      bias: "center",
      kind: "aggregator",
    });

    const members: ClusterDetailMember[] = [
      makeMember("art-outlet", outlet),
      makeMember("art-aggregator", aggregator),
    ];

    // Pre-034 consumer counted one vote per article regardless of kind, so
    // the stored distribution includes the aggregator's vote too: total 2,
    // but only 1 member actually votes live. distributionTotal (2) !==
    // votingMembers.length (1), so this must NOT claim exclusion.
    const distribution = emptyDistribution();
    distribution.pro_government = 1;
    distribution.center = 1;

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: [outlet, aggregator],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 2,
        memberCount: 2,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).toContain("Spektrum 2 kaynaktan oluşturuldu");
    expect(text).not.toContain("toplayıcı / niş kaynak sayılmadı");
    expect(text).not.toContain("sınıflandırılmış kaynaktan");
    expect(text).toContain("Toplayıcı / niş kaynaklar");
  });
});

describe("ClusterDetailPage — JSON-LD ve görsel kredisi", () => {
  it("escapes < so a hostile title cannot break out of the script tag", async () => {
    const source = makeSource({ id: "s-outlet", slug: "s-outlet", name: "Outlet Gazete" });
    const members: ClusterDetailMember[] = [makeMember("a-outlet", source)];

    const cluster = makeCluster({ bias_distribution: emptyDistribution() });
    cluster.title_tr = "Kriz </script><script>alert('xss')</script> büyüyor";
    cluster.summary_tr = "<img src=x onerror=alert(1)> özet";

    const detail: ClusterDetail = {
      cluster,
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 1,
        memberCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const html = findJsonLd(tree);

    expect(html).not.toBeNull();
    expect(html!.includes("<")).toBe(false);
    expect(html!).toContain("\\u003c");
    const parsed = JSON.parse(html!);
    expect(parsed["@type"]).toBe("NewsArticle");
    expect(parsed.headline).toBe(
      "Kriz </script><script>alert('xss')</script> büyüyor",
    );
  });

  it("points the JSON-LD image at the Tayf OG card, never the outlet photo", async () => {
    const source = makeSource({ id: "s-outlet", slug: "s-outlet", name: "Outlet Gazete" });
    const members: ClusterDetailMember[] = [
      makeMember(
        "a-outlet",
        source,
        "2026-09-06T12:00:00.000Z",
        "https://cdn.outlet.example/foto.jpg",
      ),
    ];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 1,
        memberCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const html = findJsonLd(tree);

    expect(html).not.toBeNull();
    expect(JSON.parse(html!).image).toEqual([
      "https://tayf.test/cluster/c1/opengraph-image",
    ]);
    expect(html!).not.toContain("cdn.outlet.example");
  });

  it("passes the outlet as a per-URL credit to ClusterCardImage when a hero image exists", async () => {
    const source = makeSource({ id: "s-outlet", slug: "s-outlet", name: "Outlet Gazete" });
    const members: ClusterDetailMember[] = [
      makeMember(
        "a-outlet",
        source,
        "2026-09-06T12:00:00.000Z",
        "https://cdn.outlet.example/foto.jpg",
      ),
    ];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 1,
        memberCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const credits = findCredits(tree);

    // R1-F1: the credit is keyed by image URL and handed to the client
    // component (which renders it from the same `idx` state driving the
    // visible image) rather than rendered as static server text — this
    // guarantees the credit can never name the wrong outlet after the
    // client-side fallback chain advances past the first candidate.
    expect(credits).toEqual({
      "https://cdn.outlet.example/foto.jpg": {
        href: "https://example.com/articles/a-outlet",
        name: "Outlet Gazete",
      },
    });
  });

  it("passes an empty credits map when no member has an image", async () => {
    const source = makeSource({ id: "s-outlet", slug: "s-outlet", name: "Outlet Gazete" });
    const members: ClusterDetailMember[] = [makeMember("a-outlet", source)];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 1,
        memberCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");
    const credits = findCredits(tree);

    expect(text).not.toContain("Görsel:");
    expect(credits).toEqual({});
  });

  it("BL-13: never selects or credits a hero image from a source with image_allowed=false", async () => {
    // Blocked outlet's article is the FIRST member (newest `published_at`,
    // so it would win the hero slot if the gate were skipped) — proves the
    // page derives `heroCandidates`/`heroCredits` from the real, imported
    // `imageEligibleMembers` gate rather than an inline reimplementation.
    const blocked = makeSource({
      id: "s-blocked",
      slug: "s-blocked",
      name: "Engelli Kaynak",
      image_allowed: false,
    });
    const allowed = makeSource({
      id: "s-allowed",
      slug: "s-allowed",
      name: "İzinli Kaynak",
    });
    const members: ClusterDetailMember[] = [
      makeMember(
        "a-blocked",
        blocked,
        "2026-09-06T13:00:00.000Z",
        "https://cdn.blocked.example/foto.jpg",
      ),
      makeMember(
        "a-allowed",
        allowed,
        "2026-09-06T12:00:00.000Z",
        "https://cdn.allowed.example/foto.jpg",
      ),
    ];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [blocked, allowed],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 2,
        memberCount: 2,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };

    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const heroSrc = findHeroSrc(tree);
    const credits = findCredits(tree);

    expect(heroSrc).toBe("https://cdn.allowed.example/foto.jpg");
    expect(credits).toEqual({
      "https://cdn.allowed.example/foto.jpg": {
        href: "https://example.com/articles/a-allowed",
        name: "İzinli Kaynak",
      },
    });
  });
});

describe("ClusterDetailPage — honest source count v2 (reader-data)", () => {
  it('renders "12 kaynak · 4 bağımsız başlık" when independentHeadlineCount < effectiveArticleCount', async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 12,
        memberCount: 12,
        independentHeadlineCount: 4,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");
    const hrefs = collectHrefs(tree);

    expect(text).toContain("12 kaynak");
    expect(text).toContain("4 bağımsız başlık");
    expect(hrefs).toContain("/metodoloji#tek-kaynak");
    expect(text).not.toContain("kopya sayılır");
    expect(text).not.toMatch(/bağımsız başlık.*kopya|kopya.*bağımsız başlık/);
  });

  it("does not render the independent-headline note when the counts are equal", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 5,
        memberCount: 5,
        independentHeadlineCount: 5,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).not.toContain("bağımsız başlık");
  });

  it("does not render the note when memberCount < 3 even if headline counts differ", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 2,
        memberCount: 2,
        independentHeadlineCount: 1,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).not.toContain("bağımsız başlık");
  });

  it("does not render the note when independentHeadlineCount is undefined", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 5,
        memberCount: 5,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).not.toContain("bağımsız başlık");
  });
});

describe("generateMetadata — seo-3 archived noindex", () => {
  it("marks robots index:false, follow:true when the cluster is archived (page itself still serves 200)", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution(), is_archived: true }),
      members,
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("leaves robots unset (inherits the root layout) when the cluster is not archived", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution(), is_archived: false }),
      members,
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(metadata.robots).toBeUndefined();
  });
});

describe("ClusterDetailPage — title provenance label (tests-2)", () => {
  it("shows the LLM-neutralized label, not the extractive one, when title_method is 'llm'", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({
        bias_distribution: emptyDistribution(),
        title_original: "orig",
        title_method: "llm",
      }),
      members,
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).toContain("AI ile tarafsızlaştırıldı");
    expect(text).not.toContain("Kaynak başlıklarından seçildi");
  });

  it("shows the extractive label, not the LLM one, when title_method is 'extractive'", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({
        bias_distribution: emptyDistribution(),
        title_original: "orig",
        title_method: "extractive",
      }),
      members,
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const text = collectText(tree).join("");

    expect(text).toContain("Kaynak başlıklarından seçildi");
    expect(text).not.toContain("AI ile tarafsızlaştırıldı");
  });
});

describe("ClusterDetailPage — heading outline (react-1)", () => {
  it("has exactly one h1 and no h3 that isn't preceded by an h2", async () => {
    const outlet = makeSource({
      id: "s-outlet",
      slug: "s-outlet",
      name: "Outlet Gazete",
      bias: "pro_government",
      kind: "outlet",
    });
    const aggregator = makeSource({
      id: "s-aggregator",
      slug: "s-aggregator",
      name: "Haberler.com",
      bias: "center",
      kind: "aggregator",
    });
    const members: ClusterDetailMember[] = [
      makeMember("a-outlet", outlet),
      makeMember("a-aggregator", aggregator),
    ];

    const distribution = emptyDistribution();
    distribution.pro_government = 1;

    const detail: ClusterDetail = {
      // Voting + non-voting members so FramingComparison AND the
      // Toplayıcı/niş section both render. Only FramingComparison and
      // MediaDna are expanded by collectHeadings — they are the only page
      // children that render a heading today (grep `<h[1-6]` under
      // src/components when the page's component set changes).
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: [outlet, aggregator],
      wire: { isWireRedistribution: false, effectiveArticleCount: 2, memberCount: 2 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const headings = collectHeadings(tree);

    expect(headings.filter((h) => h === "h1")).toHaveLength(1);

    let sawH2 = false;
    for (const h of headings) {
      if (h === "h2") sawH2 = true;
      if (h === "h3") expect(sawH2).toBe(true);
    }
  });
});

/** First element of the given component type in the tree, or null. */
function findElementOfType(
  node: unknown,
  type: unknown,
): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementOfType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === type) return el as { props: Record<string, unknown> };
    if (el.props?.children !== undefined) return findElementOfType(el.props.children, type);
  }
  return null;
}

describe("ClusterDetailPage — Kim önce yazdı? story timeline", () => {
  function detailFor(members: ClusterDetailMember[]): ClusterDetail {
    const distribution = emptyDistribution();
    for (const m of members) distribution[m.source.bias] += 1;
    return {
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: members.map((m) => m.source),
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: members.length,
        memberCount: members.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  const sabah = makeSource({ id: "s-sabah", name: "Sabah", bias: "pro_government", kind: "outlet" });
  const cnn = makeSource({ id: "s-cnn", name: "CNN Türk", bias: "gov_leaning", kind: "outlet" });
  const sozcu = makeSource({ id: "s-sozcu", name: "Sözcü", bias: "opposition_leaning", kind: "outlet" });
  const karar = makeSource({ id: "s-karar", name: "Karar", bias: "center", kind: "outlet" });
  const aggregator = makeSource({
    id: "s-agg",
    name: "Haberler.com",
    bias: "center",
    kind: "aggregator",
  });

  it("renders the timeline for a 3-source cluster, clamping a future pubDate to created_at", async () => {
    getClusterDetail.mockResolvedValue(
      detailFor([
        makeMember("a-sabah", sabah, "2026-09-27T06:12:00.000Z"),
        // CNN Türk-style future pubDate; Tayf saw it at 06:05Z.
        makeMember("a-cnn", cnn, "2026-09-27T09:00:00.000Z"),
        makeMember("a-sozcu", sozcu, "2026-09-27T08:22:00.000Z"),
        // Aggregators never vote — must not count toward bağımsız coverage.
        makeMember("a-agg", aggregator, "2026-09-27T06:00:00.000Z"),
      ]),
    );
    getMemberSeenAt.mockResolvedValue({ "a-cnn": "2026-09-27T06:05:00.000Z" });

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, StoryTimeline);
    expect(el).not.toBeNull();
    expect(getMemberSeenAt).toHaveBeenCalledWith("c1");
    // bağımsız has no voting member → health is consulted for the wording.
    expect(getZoneFeedHealth).toHaveBeenCalledTimes(1);

    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain("Kim önce yazdı?");
    expect(html).toContain(
      "İlk: CNN Türk · 09:05 — Bağımsız kaynaklardan bu kümede haber yok — Muhalefet 2 sa 17 dk sonra katıldı",
    );
    expect(html).toContain("Tüm sıra (3 kaynak)");
    expect(html).not.toContain("Haberler.com");
    // Acceptance criterion 3: never a claim of silence.
    expect(html).not.toMatch(/yazmad/);
    expect(collectText(tree).join("")).not.toMatch(/yazmad/);
  });

  it("skips the feed-health lookup when every zone has a member", async () => {
    getClusterDetail.mockResolvedValue(
      detailFor([
        makeMember("a-sabah", sabah, "2026-09-27T06:12:00.000Z"),
        makeMember("a-karar", karar, "2026-09-27T06:40:00.000Z"),
        makeMember("a-sozcu", sozcu, "2026-09-27T08:22:00.000Z"),
      ]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, StoryTimeline)).toBe(true);
    expect(getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("omits the timeline (and both lookups) for a 2-source cluster", async () => {
    getClusterDetail.mockResolvedValue(
      detailFor([
        makeMember("a-sabah", sabah, "2026-09-27T06:12:00.000Z"),
        makeMember("a-sozcu", sozcu, "2026-09-27T08:22:00.000Z"),
        makeMember("a-agg", aggregator, "2026-09-27T06:00:00.000Z"),
      ]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, StoryTimeline)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Kim önce yazdı");
    expect(getMemberSeenAt).not.toHaveBeenCalled();
    expect(getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("still renders from published times when the created_at lookup fails open", async () => {
    getClusterDetail.mockResolvedValue(
      detailFor([
        makeMember("a-sabah", sabah, "2026-09-27T06:12:00.000Z"),
        makeMember("a-karar", karar, "2026-09-27T06:40:00.000Z"),
        makeMember("a-sozcu", sozcu, "2026-09-27T08:22:00.000Z"),
      ]),
    );
    getMemberSeenAt.mockResolvedValue(null);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, StoryTimeline);
    const timeline = el?.props.timeline as { summary: string } | undefined;
    expect(timeline?.summary).toBe(
      "İlk: Sabah · 09:12 — Bağımsız 28 dk sonra katıldı — Muhalefet 2 sa 10 dk sonra katıldı",
    );
  });
});

describe("ClusterDetailPage — Bu konuda doğrulama (fact-check box)", () => {
  function simpleDetail(): ClusterDetail {
    const sabah = makeSource({ id: "s-sabah", name: "Sabah", bias: "pro_government" });
    const sozcu = makeSource({ id: "s-sozcu", name: "Sözcü", bias: "opposition_leaning" });
    const members = [makeMember("a-sabah", sabah), makeMember("a-sozcu", sozcu)];
    const distribution = emptyDistribution();
    for (const m of members) distribution[m.source.bias] += 1;
    return {
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: members.map((m) => m.source),
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: members.length,
        memberCount: members.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  it("renders the box with the heading, href and rel when getClusterFactChecks returns one item", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());
    getClusterFactChecks.mockResolvedValue([
      {
        id: "fc-1",
        publisher: "teyit",
        publisherLabel: "Teyit",
        url: "https://teyit.org/analiz/x",
        title: "Bir iddianın analizi",
        dateLabel: "28 Eyl 2026",
        score: 0.7,
      },
    ]);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(getClusterFactChecks).toHaveBeenCalledWith("c1");

    const el = findElementOfType(tree, FactCheckBox);
    expect(el).not.toBeNull();
    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain("Bu konuda doğrulama");
    expect(html).toContain('href="https://teyit.org/analiz/x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("omits the box entirely when getClusterFactChecks returns []", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());
    getClusterFactChecks.mockResolvedValue([]);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, FactCheckBox)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Bu konuda doğrulama");
  });
});
