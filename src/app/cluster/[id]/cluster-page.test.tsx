import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { StoryTimeline as StoryTimelineData } from "@/lib/clusters/story-timeline";
import type { BiasDistribution, Source } from "@/types";
import { FramingComparison } from "@/components/story/framing-comparison";
import { MediaDna } from "@/components/story/media-dna";
import { StoryTimeline } from "@/components/story/story-timeline";
import { FactCheckBox } from "@/components/story/fact-check-box";
import { ThreadLink } from "@/components/story/thread-link";
import { ReadAcrossSpectrum } from "@/components/story/read-across-spectrum";
import { BalanceChip } from "@/components/story/balance-chip";
import { ShareButton } from "@/components/story/share-button";
import { ClusterCardImage } from "@/components/story/cluster-card-image";
import { SourceProfileLink } from "@/components/story/source-profile-link";
import { SourceChips } from "@/components/source/source-chips";
import { BookmarkButton } from "@/components/bookmark/bookmark-button";
import { CompareButton } from "@/components/compare/compare-button";
import {
  bookmarkChipSuffix,
  bookmarkStoryLabel,
} from "@/components/bookmark/bookmark-label";

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
// Records that the page/metadata went through the THROWING variant.
const getClusterDetailOrThrowSpy = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/cluster-detail-query")>();
  return {
    ...actual,
    getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
    // The page and generateMetadata read through the throwing variant (a
    // timeout must not look like a missing cluster). Mapped to the SAME
    // vi.fn so every fixture below keeps driving the page unchanged; the
    // "timeout is not a 404" block feeds it a rejection.
    getClusterDetailOrThrow: (...args: unknown[]) => {
      getClusterDetailOrThrowSpy(...args);
      return getClusterDetail(...args);
    },
  };
});
const permanentRedirect = vi.fn((_url: string) => {
  throw new Error("REDIRECT");
});
// notFound is a no-op by default (every fixture resolves to a non-null
// detail); the 404 tests make it throw the way Next's real one does.
const notFound = vi.fn();
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  permanentRedirect: (url: string) => permanentRedirect(url),
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
// "Bu hikayenin devamı" thread pill (migration 098): Supabase-backed lookup,
// mocked so the page never reaches a real client. Defaults to null below.
const getPublishedThreadForCluster = vi.fn();
vi.mock("@/lib/story-threads/public-query", () => ({
  getPublishedThreadForCluster: (...args: unknown[]) => getPublishedThreadForCluster(...args),
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
 * Like `findCredits` but returns ALL props of the same element (the hero
 * `<ClusterCardImage>`), for assertions on the image-loading hints the page
 * passes down (`priority`, `fetchPriority`). `undefined` when no element in
 * the tree carries `credits`.
 */
function findHeroProps(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHeroProps(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: { credits?: unknown; children?: ReactNode } & Record<string, unknown>;
    };
    if (el.props?.credits !== undefined) return el.props;
    if (el.props?.children !== undefined) return findHeroProps(el.props.children);
  }
  return undefined;
}

/**
 * Like `findCredits` but returns the `minIntrinsicWidth` prop of the same
 * element (the hero `<ClusterCardImage>`): the full-width hero opts in to
 * skipping tiny source thumbnails (e.g. artigercek's 150x84) instead of
 * stretching them into a blurry banner.
 */
function findHeroMinIntrinsicWidth(node: unknown): number | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHeroMinIntrinsicWidth(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: {
        credits?: unknown;
        minIntrinsicWidth?: number;
        children?: ReactNode;
      };
    };
    if (el.props?.credits !== undefined) {
      return el.props.minIntrinsicWidth;
    }
    if (el.props?.children !== undefined) {
      return findHeroMinIntrinsicWidth(el.props.children);
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
  notFound.mockReset();
  getClusterDetail.mockReset();
  getClusterDetailOrThrowSpy.mockReset();
  getMemberSeenAt.mockReset();
  getMemberSeenAt.mockResolvedValue(null);
  getZoneFeedHealth.mockReset();
  getZoneFeedHealth.mockResolvedValue(null);
  getClusterFactChecks.mockReset();
  getClusterFactChecks.mockResolvedValue([]);
  getPublishedThreadForCluster.mockReset();
  getPublishedThreadForCluster.mockResolvedValue(null);
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

    // The hero is full-width (384px on desktop, 100vw on mobile): it opts in
    // to skipping source thumbnails narrower than 320px so a 150x84 og:image
    // is never stretched into a blurry banner.
    expect(findHeroMinIntrinsicWidth(tree)).toBe(320);

    // perf-1: the hero is the true mobile LCP on /cluster/<id>. It is both
    // preloaded (`priority`) and ranked first by the browser (`fetchPriority`).
    const heroProps = findHeroProps(tree);
    expect(heroProps).toBeDefined();
    expect(heroProps!.priority).toBe(true);
    expect(heroProps!.fetchPriority).toBe("high");
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

/**
 * The meta row under the title ("2 saat önce • 3 kaynak …"): the first
 * element whose className carries the row's text-size/weight tokens.
 */
function findMetaRow(node: unknown): { props: { children?: ReactNode } } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findMetaRow(child);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as {
      props?: { className?: unknown; children?: ReactNode };
    };
    if (
      typeof el.props?.className === "string" &&
      el.props.className.includes("text-[12px] font-medium text-muted-foreground")
    ) {
      return el as { props: { children?: ReactNode } };
    }
    if (el.props?.children !== undefined) return findMetaRow(el.props.children);
  }
  return null;
}

describe("ClusterDetailPage — header age", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function detailWithMembers(publishedAts: string[]): ClusterDetail {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const members = publishedAts.map((at, i) =>
      makeMember(`a${i}`, makeSource({ id: `s${i}`, slug: `s${i}`, name: `Kaynak ${i}` }), at),
    );
    return {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: members.length,
        memberCount: members.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  it("shows the story age plus a labelled update cue when a member published later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-06T12:30:00Z");
    getClusterDetail.mockResolvedValue(
      detailWithMembers(["2026-09-06T10:00:00.000Z", "2026-09-06T12:00:00.000Z"]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const row = findMetaRow(tree);
    expect(row).not.toBeNull();
    const rowText = collectText(row!.props.children).join("");

    // first_published 10:00 → 2.5 h old: the bare age is the story's age.
    expect(rowText).toContain("2 saat önce");
    expect(rowText).toContain("Güncellendi: 30 dakika önce");
    // "30 dakika önce" must never appear without its label (it is NOT the age).
    expect(rowText.replace("Güncellendi: 30 dakika önce", "")).not.toContain(
      "30 dakika önce",
    );
  });

  it("omits the update cue when every member published within 30 minutes of the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-06T12:30:00Z");
    getClusterDetail.mockResolvedValue(
      detailWithMembers([
        "2026-09-06T10:00:00.000Z",
        "2026-09-06T10:10:00.000Z",
        "2026-09-06T10:20:00.000Z",
      ]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const row = findMetaRow(tree);
    expect(row).not.toBeNull();
    const rowText = collectText(row!.props.children).join("");

    expect(rowText).toContain("2 saat önce");
    expect(rowText).not.toContain("Güncellendi");
  });

  it("keeps JSON-LD datePublished and dateModified on the cluster columns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-06T12:30:00Z");
    getClusterDetail.mockResolvedValue(
      detailWithMembers(["2026-09-06T10:00:00.000Z", "2026-09-06T12:00:00.000Z"]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const parsed = JSON.parse(findJsonLd(tree)!);

    expect(parsed.datePublished).toBe("2026-09-06T10:00:00.000Z");
    expect(parsed.dateModified).toBe("2026-09-06T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// h16-mobile-2: the header's meta + action row was one flex-wrap row of ~28 px
// pills and 11 px links. It is now a wrapper of two display:contents groups:
// from sm up `contents` makes it the same single flex row as before; below sm
// each group is its own full-width flex row, so the actions get their own line
// with 44 px targets and no bullet can end a line.
// ---------------------------------------------------------------------------
type TreeElement = {
  type?: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
};

/** Every element of the tree (depth-first, document order) matching `pred`. */
function findAllElements(
  node: unknown,
  pred: (el: TreeElement) => boolean,
  out: TreeElement[] = [],
): TreeElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAllElements(child, pred, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as TreeElement;
    if (el.props && pred(el)) out.push(el);
    if (el.props?.children !== undefined) findAllElements(el.props.children, pred, out);
  }
  return out;
}

/** The direct children of an element, flattened one level. */
function childList(el: TreeElement): unknown[] {
  return ([] as unknown[]).concat(el.props.children ?? []);
}

const classTokens = (el: { props: Record<string, unknown> } | undefined): string[] =>
  (typeof el?.props.className === "string" ? el.props.className : "")
    .split(/\s+/)
    .filter(Boolean);

describe("ClusterDetailPage — mobile tap targets (h16-mobile-2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function detail(wireOverrides: Partial<ClusterDetail["wire"]> = {}): ClusterDetail {
    const distribution = emptyDistribution();
    distribution.pro_government = 2;
    distribution.center = 2;
    distribution.opposition = 2;
    const s0 = makeSource({ id: "s0", slug: "s0", name: "Kaynak 0" });
    const s1 = makeSource({ id: "s1", slug: "s1", name: "Kaynak 1" });
    return {
      cluster: makeCluster({ bias_distribution: distribution }),
      members: [
        makeMember("a0", s0, "2026-09-06T10:00:00.000Z"),
        makeMember("a1", s1, "2026-09-06T12:00:00.000Z"),
      ],
      allSources: [s0, s1],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: 2,
        memberCount: 2,
        ...wireOverrides,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  async function renderTree(d: ClusterDetail = detail()) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-06T12:30:00Z");
    getClusterDetail.mockResolvedValue(d);
    return ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
  }

  const actionsOf = (tree: unknown) =>
    findAllElements(tree, (el) => el.props["data-row"] === "actions");

  it("keeps ShareButton, BookmarkButton, CompareButton and the Düzeltme link out of the meta group", async () => {
    const tree = await renderTree();
    const row = findMetaRow(tree);
    expect(row).not.toBeNull();
    for (const type of [ShareButton, BookmarkButton, CompareButton]) {
      expect(hasElementOfType(row!.props.children, type)).toBe(false);
    }
    expect(collectHrefs(row!.props.children).some((h) => h.includes("#duzeltme"))).toBe(false);
    expect(collectText(row!.props.children).join("")).not.toContain("Düzeltme talebi");
  });

  it("puts the actions in their own data-row=actions group, without the meta text classes", async () => {
    const tree = await renderTree();
    const groups = actionsOf(tree);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(String(group.props.className)).not.toContain(
      "text-[12px] font-medium text-muted-foreground",
    );
    expect(classTokens(group)).not.toContain("text-[12px]");
    expect(classTokens(group)).not.toContain("text-muted-foreground");

    expect(hasElementOfType(group.props.children, ShareButton)).toBe(true);
    expect(hasElementOfType(group.props.children, BookmarkButton)).toBe(true);
    expect(hasElementOfType(group.props.children, CompareButton)).toBe(true);
    expect(collectHrefs(group.props.children)).toContain("/metodoloji?cluster=c1#duzeltme");
    expect(collectText(group.props.children).join("")).toContain("Düzeltme talebi");
  });

  it("makes both groups display:contents from sm up and their own full-width flex row below sm", async () => {
    const tree = await renderTree();
    const row = findMetaRow(tree);
    const group = actionsOf(tree)[0];
    expect(row).not.toBeNull();
    expect(group).toBeDefined();
    const shared = [
      "contents",
      "max-sm:flex",
      "max-sm:basis-full",
      "max-sm:flex-wrap",
      "max-sm:items-center",
      "max-sm:gap-2",
      "font-medium",
    ];
    for (const token of shared) {
      expect(classTokens(row!), `meta ${token}`).toContain(token);
      expect(classTokens(group), `actions ${token}`).toContain(token);
    }
    expect(classTokens(row!)).toEqual(
      expect.arrayContaining(["text-[12px]", "text-muted-foreground"]),
    );
  });

  it("nests the two groups as siblings in one flex-wrap gap-2 wrapper (the old single row)", async () => {
    const tree = await renderTree();
    const row = findMetaRow(tree);
    const group = actionsOf(tree)[0];
    const wrappers = findAllElements(tree, (el) => {
      const kids = childList(el);
      return kids.includes(row) && kids.includes(group);
    });
    expect(wrappers).toHaveLength(1);
    expect(classTokens(wrappers[0])).toEqual(["flex", "flex-wrap", "items-center", "gap-2"]);
    // meta group first, actions second: the order of the old single row.
    const kids = childList(wrappers[0]!);
    expect(kids.indexOf(row)).toBeLessThan(kids.indexOf(group));
  });

  it("renders no standalone • flex child: each bullet lives inside its own span", async () => {
    const tree = await renderTree();
    const row = findMetaRow(tree)!;
    const direct = childList(row as TreeElement).flat(Infinity) as unknown[];
    const standalone = direct.filter(
      (c) => c && typeof c === "object" && (c as TreeElement).props?.children === "•",
    );
    expect(standalone).toEqual([]);

    const bullets = findAllElements(row, (el) => el.props.children === "•");
    expect(bullets).toHaveLength(2);
    for (const bullet of bullets) {
      expect(bullet.props["aria-hidden"]).toBe("true");
      expect(bullet.props.className).toBe("mr-2");
    }
  });

  it("prefixes the update cue and the kaynak count with their bullet inside one span", async () => {
    const tree = await renderTree();
    const row = findMetaRow(tree)!;
    const spans = findAllElements(row, (el) => el.type === "span").map((el) =>
      collectText(el.props.children).join(""),
    );
    expect(spans).toContain("•Güncellendi: 30 dakika önce");
    expect(spans).toContain("•2 kaynak");
    // the whole group reads exactly like the old row did, minus the actions.
    expect(collectText(row.props.children).join("")).toBe(
      "2 saat önce•Güncellendi: 30 dakika önce•2 kaynak",
    );
  });

  it("omits the update-cue bullet together with the cue", async () => {
    const d = detail();
    d.members = [
      makeMember("a0", d.allSources[0]!, "2026-09-06T10:00:00.000Z"),
      makeMember("a1", d.allSources[1]!, "2026-09-06T10:10:00.000Z"),
    ];
    const tree = await renderTree(d);
    const row = findMetaRow(tree)!;
    expect(collectText(row.props.children).join("")).toBe("2 saat önce•2 kaynak");
    expect(findAllElements(row, (el) => el.props.children === "•")).toHaveLength(1);
  });

  it("keeps the bağımsız başlık link and the wire chip in the meta group, not the actions", async () => {
    const tree = await renderTree(
      detail({
        isWireRedistribution: true,
        effectiveArticleCount: 5,
        memberCount: 5,
        independentHeadlineCount: 2,
      }),
    );
    const row = findMetaRow(tree)!;
    const group = actionsOf(tree)[0]!;
    const metaText = collectText(row.props.children).join("");
    expect(collectHrefs(row.props.children)).toContain("/metodoloji#tek-kaynak");
    expect(metaText).toContain("2 bağımsız başlık");
    expect(metaText).toContain("Tek kaynaktan dağıtıldı");
    const actionText = collectText(group.props.children).join("");
    expect(actionText).not.toContain("bağımsız başlık");
    expect(actionText).not.toContain("Tek kaynaktan dağıtıldı");
    expect(collectHrefs(group.props.children)).not.toContain("/metodoloji#tek-kaynak");
  });

  it("lifts the Düzeltme talebi link to a 44 px row below sm without changing its look", async () => {
    const tree = await renderTree();
    const link = findAllElements(
      tree,
      (el) => el.props.href === "/metodoloji?cluster=c1#duzeltme",
    );
    expect(link).toHaveLength(1);
    expect(classTokens(link[0])).toEqual([
      "inline-flex",
      "items-center",
      "max-sm:min-h-11",
      "text-[11px]",
      "text-muted-foreground",
      "underline",
      "decoration-dotted",
      "underline-offset-2",
      "hover:text-foreground",
    ]);
  });

  it("lifts the Denge puanı nedir? link to a 44 px row below sm", async () => {
    const tree = await renderTree();
    const link = findAllElements(tree, (el) => el.props.href === "/metodoloji#denge-puani");
    expect(link).toHaveLength(1);
    const tokens = classTokens(link[0]);
    for (const token of ["inline-flex", "items-center", "max-sm:min-h-11"]) {
      expect(tokens).toContain(token);
    }
    for (const token of ["underline", "decoration-dotted", "underline-offset-2", "hover:text-foreground"]) {
      expect(tokens).toContain(token);
    }
  });
});

describe("generateMetadata — oEmbed discovery", () => {
  it("advertises the oEmbed endpoint for the cluster URL next to the canonical", async () => {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution(), is_archived: false }),
      members: [makeMember("a1", source)],
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    const types = (metadata.alternates?.types ?? {}) as Record<string, Array<{ url: string }>>;
    const link = types["application/json+oembed"]?.[0];
    if (!link) throw new Error("no oEmbed discovery link");
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
    expect(link.url).toContain("/api/oembed?url=");
    expect(decodeURIComponent(link.url)).toContain("/cluster/c1");
    expect(link.url).toContain("format=json");
  });
});

// A mixed-case uuid in the URL (a pasted/uppercased link) is the same cluster:
// Postgres resolves uuids case-insensitively, so the page renders. Every URL
// the page ADVERTISES about itself (canonical, og:url, the oEmbed discovery
// target, the JSON-LD image) must still be the one lowercase form, or crawlers
// and unfurlers see two "different" pages for one story.
const MIXED_CASE_ID = "367A01B2-8CB4-4614-B28E-E82CC26899DB";
const LOWER_ID = "367a01b2-8cb4-4614-b28e-e82cc26899db";

function mixedCaseDetail(): ClusterDetail {
  const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
  return {
    cluster: makeCluster({ bias_distribution: emptyDistribution(), is_archived: false }),
    members: [makeMember("a1", source)],
    allSources: [source],
    wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

describe("generateMetadata — canonical id casing", () => {
  it("an uppercase uuid yields a lowercase canonical and og:url", async () => {
    getClusterDetail.mockResolvedValue(mixedCaseDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: MIXED_CASE_ID }),
    });

    expect(metadata.alternates?.canonical).toBe(`/cluster/${LOWER_ID}`);
    expect(metadata.openGraph?.url).toBe(`/cluster/${LOWER_ID}`);
  });

  it("the oEmbed discovery href targets the lowercase cluster URL only", async () => {
    getClusterDetail.mockResolvedValue(mixedCaseDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: MIXED_CASE_ID }),
    });
    const types = (metadata.alternates?.types ?? {}) as Record<string, Array<{ url: string }>>;
    const link = types["application/json+oembed"]?.[0];
    if (!link) throw new Error("no oEmbed discovery link");
    const decoded = decodeURIComponent(link.url);

    expect(decoded).toContain(`/cluster/${LOWER_ID}`);
    expect(decoded).not.toContain(MIXED_CASE_ID);
    expect(link.url).not.toContain(MIXED_CASE_ID);
  });

  it("an already-lowercase id is untouched", async () => {
    getClusterDetail.mockResolvedValue(mixedCaseDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: LOWER_ID }),
    });

    expect(metadata.alternates?.canonical).toBe(`/cluster/${LOWER_ID}`);
    expect(metadata.openGraph?.url).toBe(`/cluster/${LOWER_ID}`);
  });

  it("the JSON-LD image URL uses the lowercase id too", async () => {
    getClusterDetail.mockResolvedValue(mixedCaseDetail());

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: MIXED_CASE_ID }) });
    const html = findJsonLd(tree);

    expect(html).not.toBeNull();
    expect(JSON.parse(html!).image).toEqual([
      `https://tayf.test/cluster/${LOWER_ID}/opengraph-image`,
    ]);
    expect(html!).not.toContain(MIXED_CASE_ID);
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
        // Aggregators never vote — must not count toward bağımsız coverage,
        // the first mover or the summary, but they ARE plotted (hollow ring).
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
    // 3 voting + the (earlier) aggregator, plotted as a non-voting point.
    expect(html).toContain("Tüm sıra (4 kaynak)");
    expect(html).toContain("Haberler.com");
    expect(html).toContain("(toplayıcı / niş)");
    expect(html).toContain("İçi boş daire");
    // Zone list: voting zones only — bağımsız has no VOTING member.
    expect(html).toContain('aria-label="Bölgelerin ilk haber saatleri"');
    expect(html).toContain(
      "<span class=\"text-foreground\">İktidar</span><span class=\"font-mono tabular-nums\">09:05</span>",
    );
    expect(html).not.toContain('<span class="text-foreground">Bağımsız</span>');
    const timeline = (el as unknown as { props: { timeline: StoryTimelineData } }).props.timeline;
    expect(timeline.points.map((p) => [p.sourceName, p.voting])).toEqual([
      ["Haberler.com", false],
      ["CNN Türk", true],
      ["Sabah", true],
      ["Sözcü", true],
    ]);
    expect(timeline.first.sourceName).toBe("CNN Türk");
    expect(timeline.zoneFirsts.map((z) => z.zone)).toEqual(["iktidar", "muhalefet"]);
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

  it("does not let non-voting sources reach the 3-source floor", async () => {
    const aggregator2 = makeSource({ id: "s-agg2", name: "Haber Sitesi", bias: "center", kind: "aggregator" });
    const aggregator3 = makeSource({ id: "s-agg3", name: "Derleme", bias: "center", kind: "aggregator" });
    getClusterDetail.mockResolvedValue(
      detailFor([
        makeMember("a-sabah", sabah, "2026-09-27T06:12:00.000Z"),
        makeMember("a-sozcu", sozcu, "2026-09-27T08:22:00.000Z"),
        makeMember("a-agg", aggregator, "2026-09-27T06:00:00.000Z"),
        makeMember("a-agg2", aggregator2, "2026-09-27T06:01:00.000Z"),
        makeMember("a-agg3", aggregator3, "2026-09-27T06:02:00.000Z"),
      ]),
    );

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, StoryTimeline)).toBe(false);
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

describe("ClusterDetailPage — Bu hikayenin devamı (story thread link)", () => {
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

  it("renders the pill linking to /hikaye/{slug} for a published thread", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());
    getPublishedThreadForCluster.mockResolvedValue({
      slug: "sarpyener-fon-a1b2c3",
      title: "Sarpyener fon soruşturması",
    });

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(getPublishedThreadForCluster).toHaveBeenCalledWith("c1");

    const el = findElementOfType(tree, ThreadLink);
    expect(el).not.toBeNull();
    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain('href="/hikaye/sarpyener-fon-a1b2c3"');
    expect(html).toContain("Bu hikayenin devamı");
    expect(html).toContain("Sarpyener fon soruşturması");
  });

  it("renders no link when the cluster is in no published thread", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, ThreadLink)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Bu hikayenin devamı");
  });
});

// ---------------------------------------------------------------------------
// A4 — missing-row generateMetadata hygiene: a soft-404 must not carry
// index,follow or a homepage canonical, even though the page body itself
// still streams 200 until the DB-backed check (notFound()) runs.
// ---------------------------------------------------------------------------
describe("generateMetadata — missing cluster (A4)", () => {
  it("returns noindex and no canonical when getClusterDetail resolves null", async () => {
    getClusterDetail.mockResolvedValue(null);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "missing" }) });

    expect(metadata.title).toBe("Sayfa bulunamadı");
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toEqual({ canonical: null });
  });
});

// ---------------------------------------------------------------------------
// B — mobile "Kaynak künyesi" clipping (browser-qa-6): the <li> and <ul>
// under the "Kaynak künyesi" heading must wrap instead of overflowing.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — Kaynak künyesi wrap (B)", () => {
  it("gives the <ul> min-w-0 and each <li> flex-wrap/min-w-0/max-w-full", async () => {
    // sabah is a known-tagged slug (see source-chips.test.ts).
    const source = makeSource({ id: "sabah", slug: "sabah", name: "Sabah" });
    const members: ClusterDetailMember[] = [makeMember("a1", source)];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    function findByType(node: unknown, type: string): { props?: Record<string, unknown> } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findByType(child, type);
          if (found) return found;
        }
        return null;
      }
      if (node && typeof node === "object") {
        const el = node as { type?: unknown; props?: { children?: ReactNode } };
        if (el.type === type) return el as { props?: Record<string, unknown> };
        if (el.props?.children !== undefined) return findByType(el.props.children, type);
      }
      return null;
    }

    const ul = findByType(tree, "ul");
    // There are multiple <ul>s on the page; walk all of them and find the
    // one whose className mentions gap-x-3 (the künye list's signature).
    function findAllByType(node: unknown, type: string, out: { props?: Record<string, unknown> }[] = []) {
      if (Array.isArray(node)) {
        for (const child of node) findAllByType(child, type, out);
        return out;
      }
      if (node && typeof node === "object") {
        const el = node as { type?: unknown; props?: { children?: ReactNode } };
        if (el.type === type) out.push(el as { props?: Record<string, unknown> });
        if (el.props?.children !== undefined) findAllByType(el.props.children, type, out);
      }
      return out;
    }
    const uls = findAllByType(tree, "ul");
    const kunyeUl = uls.find((u) =>
      String(u.props?.className ?? "").includes("gap-x-3"),
    );
    expect(kunyeUl).toBeDefined();
    expect(String(kunyeUl?.props?.className)).toContain("min-w-0");
    void ul;

    const lis = findAllByType(tree, "li");
    const kunyeLi = lis.find((li) => String(li.props?.className ?? "").includes("animate-fade-up"));
    expect(kunyeLi).toBeDefined();
    const liClass = String(kunyeLi?.props?.className);
    expect(liClass).toContain("flex-wrap");
    expect(liClass).toContain("min-w-0");
    expect(liClass).toContain("max-w-full");
  });
});

// ---------------------------------------------------------------------------
// h16-mobile-3 — each "Kaynak künyesi" source name links to /source/<slug>, so
// a reader can reach an outlet's bias karne from the story. SourceChips and
// SourceBadge stay non-interactive; outbound article links are untouched.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — Kaynak künyesi kaynak profiline bağlanır (h16-mobile-3)", () => {
  async function renderKunye() {
    // sabah and trt-haber are both in SOURCE_METADATA; the niche slug is not,
    // so it never reaches the künye list, only the Toplayıcı / niş section.
    const sabah = makeSource({ id: "sabah", slug: "sabah", name: "Sabah" });
    const trt = makeSource({ id: "trt-haber", slug: "trt-haber", name: "TRT Haber" });
    const niche = makeSource({
      id: "niche-x",
      slug: "niche-x",
      name: "Niş Kaynak",
      bias: "opposition",
      kind: "niche",
    });

    const members: ClusterDetailMember[] = [
      makeMember("a-sabah-1", sabah),
      makeMember("a-sabah-2", sabah),
      makeMember("a-trt", trt),
      makeMember("a-niche", niche),
    ];
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [sabah, trt, niche],
      wire: { isWireRedistribution: false, effectiveArticleCount: 4, memberCount: 4 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const kunyeUl = findAllElements(
      tree,
      (el) =>
        el.type === "ul" &&
        typeof el.props.className === "string" &&
        el.props.className.includes("gap-x-3") &&
        el.props.className.includes("min-w-0"),
    )[0];
    return { tree, kunyeUl, nicheMember: members[3]! };
  }

  it("renders one SourceProfileLink per unique rated source, in künye order", async () => {
    const { tree } = await renderKunye();

    const links = findAllElements(tree, (el) => el.type === SourceProfileLink);
    expect(links).toHaveLength(2);
    expect(links.map((l) => ({ slug: l.props.slug, name: l.props.name }))).toEqual([
      { slug: "sabah", name: "Sabah" },
      { slug: "trt-haber", name: "TRT Haber" },
    ]);
  });

  it("keeps each SourceProfileLink in the same <li> as the SourceChips of that slug", async () => {
    const { kunyeUl } = await renderKunye();
    expect(kunyeUl).toBeDefined();

    const lis = findAllElements(kunyeUl, (el) => el.type === "li");
    expect(lis).toHaveLength(2);
    for (const li of lis) {
      const kids = childList(li as TreeElement) as TreeElement[];
      const link = kids.find((k) => k?.type === SourceProfileLink);
      const chips = kids.find((k) => k?.type === SourceChips);
      expect(link).toBeDefined();
      expect(chips).toBeDefined();
      expect(chips!.props.slug).toBe(link!.props.slug);
    }
  });

  it("renders exactly one profile anchor per source in the künye markup, no target", async () => {
    const { kunyeUl } = await renderKunye();
    expect(kunyeUl).toBeDefined();

    const html = renderToStaticMarkup(kunyeUl as unknown as ReactElement);
    expect(html.split('href="/source/sabah"')).toHaveLength(2);
    expect(html.split('href="/source/trt-haber"')).toHaveLength(2);
    expect(html).not.toContain("target=");

    const anchorText = (slug: string) =>
      new RegExp(`<a [^>]*href="/source/${slug}"[^>]*>([^<]*)</a>`).exec(html)?.[1];
    expect(anchorText("sabah")).toBe("Sabah");
    expect(anchorText("trt-haber")).toBe("TRT Haber");
  });

  it("leaves the niche member's outbound article link untouched", async () => {
    const { tree, nicheMember } = await renderKunye();

    const outbound = findAllElements(
      tree,
      (el) => el.type === "a" && el.props.href === nicheMember.article.url,
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.props.href).toBe(nicheMember.article.url);
    expect(outbound[0]!.props.target).toBe("_blank");
    expect(outbound[0]!.props.rel).toBe("noopener noreferrer");
  });
});

// ---------------------------------------------------------------------------
// D — blindspot copy names non-voting writers from the silent side
// (browser-qa-11). nonVotingZoneCounts is computed from nonVotingMembers,
// deduped by source.slug, and passed to <ReadAcrossSpectrum>.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — nonVotingZoneCounts (D)", () => {
  it("passes a zone-keyed count of deduped non-voting members to ReadAcrossSpectrum", async () => {
    const voter = makeSource({ id: "gov", slug: "gov", name: "Gov Outlet", bias: "pro_government", kind: "outlet" });
    const niche1 = makeSource({ id: "niche1", slug: "niche-muhalefet", name: "Niche 1", bias: "opposition", kind: "niche" });
    const niche2 = makeSource({ id: "niche2", slug: "niche-muhalefet", name: "Niche 1 dup", bias: "opposition", kind: "niche" });

    const members: ClusterDetailMember[] = [
      makeMember("a-gov", voter),
      makeMember("a-niche1", niche1),
      makeMember("a-niche2", niche2),
    ];

    const distribution = emptyDistribution();
    distribution.pro_government = 1;

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: [voter, niche1, niche2],
      wire: { isWireRedistribution: false, effectiveArticleCount: 3, memberCount: 3 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, ReadAcrossSpectrum);
    expect(el).not.toBeNull();
    expect(el?.props.nonVotingZoneCounts).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// F — structured data: NewsArticle author/publisher is Tayf, with outlets
// listed in isBasedOn instead of masquerading as bylines.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — structured data (F)", () => {
  it("author is Tayf (never an outlet name), publisher carries a logo, and isBasedOn lists member article URLs", async () => {
    const s1 = makeSource({ id: "s1", slug: "s1", name: "Outlet One" });
    const s2 = makeSource({ id: "s2", slug: "s2", name: "Outlet Two" });
    const members: ClusterDetailMember[] = [
      makeMember("a1", s1, "2026-09-06T12:00:00.000Z"),
      makeMember("a2", s2, "2026-09-06T12:00:00.000Z"),
    ];

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [s1, s2],
      wire: { isWireRedistribution: false, effectiveArticleCount: 2, memberCount: 2 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const html = findJsonLd(tree);
    expect(html).not.toBeNull();
    const parsed = JSON.parse(html!);

    expect(parsed.author).toEqual([
      { "@type": "Organization", name: "Tayf", url: "https://tayf.test" },
    ]);
    for (const a of parsed.author) {
      expect(a.name).not.toBe("Outlet One");
      expect(a.name).not.toBe("Outlet Two");
    }
    expect(parsed.publisher.logo.url).toMatch(/\/apple-icon$/);
    expect(parsed.isBasedOn).toEqual([
      "https://example.com/articles/a1",
      "https://example.com/articles/a2",
    ]);
  });

  it("omits isBasedOn when no member has an http(s) article url", async () => {
    const s1 = makeSource({ id: "s1", slug: "s1", name: "Outlet One" });
    const members: ClusterDetailMember[] = [makeMember("a1", s1)];
    members[0]!.article.url = "not-a-url";

    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [s1],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const html = findJsonLd(tree);
    const parsed = JSON.parse(html!);
    expect(parsed.isBasedOn).toBeUndefined();
  });
});

// Migration 099: a cluster merged into another one redirects permanently
// (streamed fallback for the middleware gate's cold / over-cap cases) and its
// metadata is noindex with the canonical pointing at the survivor.
describe("merged cluster (migration 099)", () => {
  const TARGET = "22222222-2222-4222-8222-222222222222";

  function mergedDetail(): ClusterDetail {
    const src = makeSource({ id: "s1", kind: "outlet" });
    return {
      cluster: { ...makeCluster({ bias_distribution: emptyDistribution(), is_archived: true }), merged_into: TARGET },
      members: [makeMember("a1", src)],
      allSources: [src],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  beforeEach(() => {
    permanentRedirect.mockClear();
    getClusterDetail.mockResolvedValue(mergedDetail());
  });

  it("permanently redirects the page to the surviving cluster", async () => {
    await expect(ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) })).rejects.toThrow("REDIRECT");
    expect(permanentRedirect).toHaveBeenCalledWith(`/cluster/${TARGET}`);
  });

  it("returns noindex,follow metadata canonicalised to the survivor", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe(`/cluster/${TARGET}`);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("does not redirect a live cluster", async () => {
    const d = mergedDetail();
    d.cluster.merged_into = null;
    d.cluster.is_archived = false;
    getClusterDetail.mockResolvedValue(d);
    await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience: a Supabase timeout is NOT a 404. The page and
// generateMetadata read through getClusterDetailOrThrow, which rejects on a
// sustained failure and resolves null only for a genuinely missing row.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — timeout is not a 404", () => {
  const TIMEOUT = new Error(
    "[cluster-detail] cluster query error: AbortError: Supabase request exceeded 4000 ms",
  );

  it("reads the page body and the metadata through getClusterDetailOrThrow", async () => {
    getClusterDetail.mockResolvedValue(null);
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(getClusterDetailOrThrowSpy).toHaveBeenCalledTimes(1);
    expect(getClusterDetailOrThrowSpy).toHaveBeenLastCalledWith("c1");

    await expect(
      ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getClusterDetailOrThrowSpy).toHaveBeenCalledTimes(2);
  });

  it("lets a read failure propagate to error.tsx instead of calling notFound()", async () => {
    getClusterDetail.mockRejectedValue(TIMEOUT);

    await expect(
      ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) }),
    ).rejects.toThrow("AbortError");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("answers generateMetadata with a noindex, canonical-less 'unavailable' shell", async () => {
    getClusterDetail.mockRejectedValue(TIMEOUT);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata).toEqual({
      title: "Haber şu anda yüklenemiyor",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    });
    // Distinct from the soft-404 shell: this is "try again", not "gone".
    expect(metadata.title).not.toBe("Sayfa bulunamadı");
  });

  it("still calls notFound() for a genuinely missing cluster (null)", async () => {
    getClusterDetail.mockResolvedValue(null);
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("keeps the soft-404 metadata for a genuinely missing cluster", async () => {
    getClusterDetail.mockResolvedValue(null);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(metadata.title).toBe("Sayfa bulunamadı");
  });
});

// ---------------------------------------------------------------------------
// Denge puanı — the 0-100 balance chip under the spectrum caption. Same basis
// as the spectrum above it: bias_distribution collapsed to the 3 zones.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — Denge puanı chip", () => {
  function detailWith(distribution: BiasDistribution): ClusterDetail {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak", kind: "outlet" });
    return {
      cluster: makeCluster({ bias_distribution: distribution }),
      members: [makeMember("a1", source)],
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  it("renders the full chip and the methodology link for a 2/2/2-zone distribution", async () => {
    const distribution = emptyDistribution();
    distribution.pro_government = 2;
    distribution.center = 2;
    distribution.opposition = 2;
    getClusterDetail.mockResolvedValue(detailWith(distribution));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, BalanceChip);
    expect(el).not.toBeNull();
    expect(el?.props.variant).toBe("full");

    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain("Denge puanı 100/100: Dengeli kapsama");
    expect(collectHrefs(tree)).toContain("/metodoloji#denge-puani");
    expect(collectText(tree).join("")).toContain("Denge puanı nedir?");
  });

  it("counts zones, not categories: 4 iktidar categories vs 1 muhalefet is not balanced", async () => {
    const distribution = emptyDistribution();
    distribution.pro_government = 2;
    distribution.gov_leaning = 2;
    distribution.nationalist = 2;
    distribution.state_media = 2;
    distribution.opposition = 1;
    getClusterDetail.mockResolvedValue(detailWith(distribution));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, BalanceChip);
    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain("Tek tarafta");
    expect(html).not.toContain("Dengeli kapsama");
  });

  it("shows the 'Az kaynak' chip when fewer than 5 classified sources voted", async () => {
    const distribution = emptyDistribution();
    distribution.pro_government = 1;
    distribution.opposition = 1;
    getClusterDetail.mockResolvedValue(detailWith(distribution));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, BalanceChip);
    expect(el).not.toBeNull();
    const html = renderToStaticMarkup(
      el as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(html).toContain("Denge puanı yok · Az kaynak");
  });

  it("renders no Denge puanı at all when the distribution total is 0", async () => {
    getClusterDetail.mockResolvedValue(detailWith(emptyDistribution()));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(hasElementOfType(tree, BalanceChip)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Denge puanı");
    expect(collectHrefs(tree)).not.toContain("/metodoloji#denge-puani");
  });
});

describe("cluster/[id]/page.tsx — contrast sweep", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pageSource = readFileSync(join(here, "page.tsx"), "utf8");

  it("no longer dims the Toplayıcı / niş section with opacity-70", () => {
    expect(pageSource).not.toContain("p-4 opacity-70");
    expect(pageSource).not.toMatch(/\bopacity-70\b/);
  });

  it("keeps the dashed border and tinted background that set the section apart", () => {
    expect(pageSource).toContain(
      "rounded-xl border border-dashed border-border/50 bg-card/20 p-4 animate-fade-up stagger-2",
    );
  });
});

// ---------------------------------------------------------------------------
// Headline-less clusters (hunt-10 C-entity-only-titles). Prod served
// /cluster/46467982-... with <title>&amp;nbsp — Tayf</title> and
// "index, follow": the repaired title_tr is the literal '&nbsp' (the feed
// dropped the semicolon of a double-encoded "&amp;nbsp;"). Reader side only,
// no data rewrite: a cluster whose title has no letter or digit after
// decoding gets the neutral title "Haber" and is noindex, follow. Every other
// cluster is unchanged.
// ---------------------------------------------------------------------------

/** Text of the first <h1> in the page tree, or null. */
function findH1Text(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findH1Text(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === "h1") return collectText(el.props?.children).join("");
    if (el.props?.children !== undefined) return findH1Text(el.props.children);
  }
  return null;
}

/** Props of the first element of the given component type, or null. */
function findPropsOfType(
  node: unknown,
  type: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPropsOfType(child, type);
      if (found !== null) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> & { children?: ReactNode } };
    if (el.type === type) return el.props ?? {};
    if (el.props?.children !== undefined) return findPropsOfType(el.props.children, type);
  }
  return null;
}

function headlessDetail(titleTr: string, isArchived = false): ClusterDetail {
  const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
  const cluster = makeCluster({
    bias_distribution: emptyDistribution(),
    is_archived: isArchived,
  });
  cluster.title_tr = titleTr;
  // No summary, so the description falls to the "N kaynak." form and the only
  // place the title could leak into it is `describeForMeta`'s `title` option.
  cluster.summary_tr = "";
  return {
    cluster,
    members: [makeMember("a1", source)],
    allSources: [source],
    wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

describe("generateMetadata — headline-less title (hunt-10 C-entity-only-titles)", () => {
  it.each([
    ["the prod literal '&nbsp'", "&nbsp"],
    ["a hyphen", "-"],
    ["a double-encoded '&amp;nbsp'", "&amp;nbsp"],
    ["an ellipsis", "…"],
    ["a HANGUL FILLER", "\u3164"],
    ["an empty title", ""],
  ])("%s: neutral title, noindex+follow, no entity in the description", async (_label, titleTr) => {
    getClusterDetail.mockResolvedValue(headlessDetail(titleTr));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.title).toBe("Haber");
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.openGraph?.title).toBe("Haber");
    expect(metadata.twitter?.title).toBe("Haber");
    const types = (metadata.alternates?.types ?? {}) as Record<string, Array<{ title?: string }>>;
    expect(types["application/json+oembed"]?.[0]?.title).toBe("Haber");
    // The "N kaynak." form: no "tek haber: <title>" tail built from the junk.
    expect(metadata.description).toBe("1 kaynak.");
    expect(String(metadata.description)).not.toContain("nbsp");
    expect(metadata.openGraph?.description).toBe("1 kaynak.");
    expect(metadata.twitter?.description).toBe("1 kaynak.");
    // The canonical is untouched: the page is still reachable and still its own URL.
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
    expect(metadata.openGraph?.url).toBe("/cluster/c1");
  });

  it("an archived headline-less cluster stays noindex+follow with the neutral title", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("&nbsp", true));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.title).toBe("Haber");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it.each([
    ["an ordinary headline", "Merkez Bankası faizi sabit tuttu"],
    ["an ampersand headline", "AT&T hisseleri yükseldi"],
    ["a one-letter headline", "a"],
    ["a digits-only headline", "2025"],
  ])("%s: title unchanged, robots left to the root layout", async (_label, titleTr) => {
    getClusterDetail.mockResolvedValue(headlessDetail(titleTr));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.title).toBe(titleTr);
    expect(metadata.robots).toBeUndefined();
    expect(metadata.openGraph?.title).toBe(titleTr);
    expect(metadata.twitter?.title).toBe(titleTr);
    const types = (metadata.alternates?.types ?? {}) as Record<string, Array<{ title?: string }>>;
    expect(types["application/json+oembed"]?.[0]?.title).toBe(titleTr);
    expect(String(metadata.description)).toContain(titleTr);
  });
});

describe("ClusterDetailPage — headline-less title (hunt-10 C-entity-only-titles)", () => {
  it("renders 'Haber' as the h1 and as the JSON-LD headline for the prod '&nbsp' title", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("&nbsp"));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findH1Text(tree)).toBe("Haber");
    const html = findJsonLd(tree);
    expect(html).not.toBeNull();
    const parsed = JSON.parse(html!);
    expect(parsed.headline).toBe("Haber");
    expect(parsed.description).toBe("1 kaynak.");
    expect(html!).not.toContain("nbsp");
  });

  it("renders 'Haber' for a hyphen-only title too", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("-"));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findH1Text(tree)).toBe("Haber");
    expect(JSON.parse(findJsonLd(tree)!).headline).toBe("Haber");
  });

  it("keeps a normal title as the h1 and the JSON-LD headline", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("Merkez Bankası faizi sabit tuttu"));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findH1Text(tree)).toBe("Merkez Bankası faizi sabit tuttu");
    const parsed = JSON.parse(findJsonLd(tree)!);
    expect(parsed.headline).toBe("Merkez Bankası faizi sabit tuttu");
    expect(parsed.description).toContain("Merkez Bankası faizi sabit tuttu");
  });

  it.each([
    ["the prod literal '&nbsp'", "&nbsp"],
    ["a hyphen", "-"],
    ["an empty title", ""],
  ])(
    "%s: ShareButton gets 'Haber' and BookmarkButton gets no story title (no junk in the share sheet, /saved or the aria name)",
    async (_label, titleTr) => {
      getClusterDetail.mockResolvedValue(headlessDetail(titleTr));

      const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

      const share = findPropsOfType(tree, ShareButton);
      expect(share).not.toBeNull();
      expect(share!.title).toBe("Haber");
      expect(share!.clusterId).toBe("c1");

      const bookmark = findPropsOfType(tree, BookmarkButton);
      expect(bookmark).not.toBeNull();
      // null (not the 'Haber' label): /saved would store a made-up title, and
      // the label helpers fall back to the generic "Kaydet" copy on null.
      expect(bookmark!.storyTitle).toBeNull();
      expect(bookmark!.clusterId).toBe("c1");
      expect(bookmarkChipSuffix(bookmark!.storyTitle as string | null)).toBeNull();
      expect(bookmarkStoryLabel(bookmark!.storyTitle as string | null)).toBe("Hikâyeyi kaydet");

      // Nothing the share/bookmark controls receive carries the entity.
      expect(JSON.stringify({ share, bookmark })).not.toContain("nbsp");
    },
  );

  it("the hero image alt falls back to 'Haber', not the entity, when no member title is available", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("&nbsp"));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero).not.toBeNull();
    expect(hero!.alt).toBe("Haber");
  });

  it("keeps a normal title on ShareButton and BookmarkButton", async () => {
    getClusterDetail.mockResolvedValue(headlessDetail("Merkez Bankası faizi sabit tuttu"));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findPropsOfType(tree, ShareButton)!.title).toBe("Merkez Bankası faizi sabit tuttu");
    expect(findPropsOfType(tree, BookmarkButton)!.storyTitle).toBe("Merkez Bankası faizi sabit tuttu");
  });
});
