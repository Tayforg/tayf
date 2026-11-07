import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { StoryTimeline as StoryTimelineData } from "@/lib/clusters/story-timeline";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import type { BiasDistribution, Source } from "@/types";
import { FramingComparison } from "@/components/story/framing-comparison";
import { MediaDna } from "@/components/story/media-dna";
import { StoryTimeline } from "@/components/story/story-timeline";
import { FactCheckBox } from "@/components/story/fact-check-box";
import { ThreadLink } from "@/components/story/thread-link";
import { RelatedStories } from "@/components/story/related-stories";
import { ReadAcrossSpectrum } from "@/components/story/read-across-spectrum";
import { RelativeTime } from "@/components/story/relative-time";
import { StaleCopyNotice } from "@/components/pwa/stale-copy-notice";
import { BalanceChip } from "@/components/story/balance-chip";
import { ShareButton } from "@/components/story/share-button";
import { ClusterCardImage } from "@/components/story/cluster-card-image";
import { SourceProfileLink } from "@/components/story/source-profile-link";
import { SourceKunye, KUNYE_VISIBLE } from "@/components/story/source-kunye";
import { SourceChips } from "@/components/source/source-chips";
import { SOURCE_METADATA } from "@/lib/sources/factuality";
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
// next/navigation: `notFound()` is a spy that does nothing by default (every
// fixture resolves to a non-null detail); the 404 tests make it throw
// 'NEXT_NOT_FOUND' the way Next's real one does. Mocked so importing it never
// depends on a live Next.js request context.
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
// "İlgili haberler" block: the two feed fetchers it reuses are Supabase-backed
// (topic hubs and the home feed), mocked so the page never reaches a real
// client. importOriginal keeps TOPIC_SLUGS / TOPIC_LABELS_TR / the types real.
// Defaults (null / an empty feed) are set in beforeEach.
const getTopicClusters = vi.fn();
vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: (...args: unknown[]) => getTopicClusters(...args),
  };
});
const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return {
    ...actual,
    getPoliticsClusters: (...args: unknown[]) => getPoliticsClusters(...args),
  };
});

import {
  RETRY_COOLDOWN_MS,
  __resetCacheResilienceForTests,
} from "@/lib/cache-resilience";

import ClusterDetailPage, { generateMetadata } from "./page";

/**
 * Collects every string/number leaf under a React element tree.
 *
 * h47-time-1: the page prints its ages through <RelativeTime>, a client
 * component the unexpanded page tree leaves as a childless element. Its server
 * text is what the SSR HTML (and so a reader's first paint) carries, so it is
 * expanded here through the real server render; every assertion on an age
 * string below therefore still reads the text a reader sees.
 */
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
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === RelativeTime) {
      out.push(renderToStaticMarkup(node as ReactElement).replace(/<[^>]+>/g, ""));
      return out;
    }
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
  article_count?: number;
  title_original?: string | null;
  title_method?: ClusterDetail["cluster"]["title_method"];
}): ClusterDetail["cluster"] {
  return {
    id: "c1",
    title_tr: "Test kümesi",
    title_original: overrides.title_original ?? null,
    title_method: overrides.title_method ?? null,
    summary_tr: "Test özeti",
    article_count: overrides.article_count ?? 3,
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
  // The related slot single-flights its topic read per slug and arms a 5 s
  // cooldown after a failed one: that module state must not leak across tests.
  __resetCacheResilienceForTests();
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
  getTopicClusters.mockReset();
  getTopicClusters.mockResolvedValue(null);
  getPoliticsClusters.mockReset();
  getPoliticsClusters.mockResolvedValue({
    bundles: [],
    breakingBundles: [],
    prefilterCount: 0,
  });
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

    // h32-a11y-2: the separator is not part of the link. The anchor's name is
    // exactly "4 bağımsız başlık" (no leading "·" read aloud and underlined),
    // and it follows an aria-hidden "•" inside one span, like its siblings.
    const links = findAllElements(
      tree,
      (el) => el.props.href === "/metodoloji#tek-kaynak",
    );
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(collectText(link.props.children).join("")).toBe("4 bağımsız başlık");

    const parents = findAllElements(tree, (el) => childList(el).includes(link));
    expect(parents).toHaveLength(1);
    const parent = parents[0]!;
    expect(parent.type).toBe("span");
    const separator = childList(parent)[0] as TreeElement;
    expect(separator.type).toBe("span");
    expect(separator.props["aria-hidden"]).toBe("true");
    expect(collectText(separator.props.children).join("")).toBe("•");
    expect(childList(parent)[1]).toBe(link);
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
// h47-time-1: the service worker keeps /cluster/<id> pages for up to 14 days and
// serves them offline, on a timeout or on a 5xx. A copy carried plain server age
// strings that never moved ("Güncellendi: 33 dakika önce") and nothing said it
// was a copy. The page now takes ONE render stamp in its per-request body and
// threads it into every age (<RelativeTime nowMs>, which re-bases after mount)
// and into <StaleCopyNotice renderedAtMs>, which speaks up past 30 minutes.
// The SSR text of every age is unchanged.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — ages and notice on service-worker copies (h47-time-1)", () => {
  const RENDERED_AT = Date.parse("2026-09-06T12:30:00Z");
  const FIRST = "2026-09-06T10:00:00.000Z";
  const LATER = "2026-09-06T12:00:00.000Z";

  afterEach(() => {
    vi.useRealTimers();
  });

  function twoMemberDetail(): ClusterDetail {
    const s0 = makeSource({ id: "s0", slug: "s0", name: "Kaynak 0", bias: "pro_government" });
    const s1 = makeSource({ id: "s1", slug: "s1", name: "Kaynak 1", bias: "opposition" });
    const members = [makeMember("a0", s0, FIRST), makeMember("a1", s1, LATER)];
    return {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [s0, s1],
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: members.length,
        memberCount: members.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  async function renderAt(nowMs: number): Promise<unknown> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
    getClusterDetail.mockResolvedValue(twoMemberDetail());
    return ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
  }

  const relativeTimes = (tree: unknown) =>
    findAllElements(tree, (el) => el.type === RelativeTime);
  const noticesOf = (tree: unknown) =>
    findAllElements(tree, (el) => el.type === StaleCopyNotice);

  it("prints the header age and the Güncellendi cue through RelativeTime on one shared nowMs", async () => {
    const tree = await renderAt(RENDERED_AT);
    const times = relativeTimes(tree);
    expect(times.map((t) => t.props.iso)).toEqual([FIRST, LATER]);
    expect(times.map((t) => t.props.nowMs)).toEqual([RENDERED_AT, RENDERED_AT]);
  });

  it("mounts one StaleCopyNotice stamped with that very nowMs", async () => {
    const tree = await renderAt(RENDERED_AT);
    const notices = noticesOf(tree);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.props.renderedAtMs).toBe(RENDERED_AT);
    expect(notices[0]?.props.renderedAtMs).toBe(relativeTimes(tree)[0]?.props.nowMs);
  });

  it("threads the same nowMs into ReadAcrossSpectrum and FramingComparison", async () => {
    const tree = await renderAt(RENDERED_AT);
    const across = findAllElements(tree, (el) => el.type === ReadAcrossSpectrum);
    const framing = findAllElements(tree, (el) => el.type === FramingComparison);
    expect(across).toHaveLength(1);
    expect(framing).toHaveLength(1);
    expect(across[0]?.props.nowMs).toBe(RENDERED_AT);
    expect(framing[0]?.props.nowMs).toBe(RENDERED_AT);
  });

  it("keeps the SSR age text byte-identical: '2 saat önce' and 'Güncellendi: 30 dakika önce'", async () => {
    const tree = await renderAt(RENDERED_AT);
    const [age, cue] = relativeTimes(tree);
    expect(renderToStaticMarkup(age as unknown as ReactElement)).toBe(
      `<time dateTime="${FIRST}">2 saat önce</time>`,
    );
    expect(renderToStaticMarkup(cue as unknown as ReactElement)).toBe(
      `<time dateTime="${LATER}">30 dakika önce</time>`,
    );
    const row = findMetaRow(tree);
    expect(collectText(row!.props.children).join("")).toBe(
      "2 saat önce•Güncellendi: 30 dakika önce•2 kaynak",
    );
  });

  it("renders no notice text on the server: only an empty, screen-reader-only live region until the document's load time says the copy is old", async () => {
    const tree = await renderAt(RENDERED_AT);
    const [notice] = noticesOf(tree);
    expect(renderToStaticMarkup(notice as unknown as ReactElement)).toMatch(
      /^<div [^>]*role="status"[^>]*class="sr-only"[^>]*><\/div>$/,
    );
    expect(collectText(tree).join("")).not.toContain("kayıtlı bir kopyasını");
  });

  it("takes the stamp per request: a later render carries a later nowMs, not a module constant", async () => {
    const first = await renderAt(RENDERED_AT);
    const later = await renderAt(RENDERED_AT + 3_600_000);
    expect(noticesOf(first)[0]?.props.renderedAtMs).toBe(RENDERED_AT);
    expect(noticesOf(later)[0]?.props.renderedAtMs).toBe(RENDERED_AT + 3_600_000);
    expect(relativeTimes(later).map((t) => t.props.nowMs)).toEqual([
      RENDERED_AT + 3_600_000,
      RENDERED_AT + 3_600_000,
    ]);
  });

  it("puts the notice near the top of the article, before the hero", async () => {
    const tree = await renderAt(RENDERED_AT);
    const ordered = findAllElements(
      tree,
      (el) => el.type === StaleCopyNotice || el.type === ClusterCardImage,
    );
    expect(ordered[0]?.type).toBe(StaleCopyNotice);
  });
});

// ---------------------------------------------------------------------------
// h47-personal-4: /diyetim counts an outbound click that carries a zone as a
// read. FramingComparison and ReadAcrossSpectrum send `zone` on every link, which
// is only right while they are fed voting members: an aggregator labelled
// `center` must never fill the Bağımsız column or become the "karşı taraf". The
// page is the single call site and filters with partitionByVote; this pins it.
// (story-timeline.tsx, which does plot non-voting points, drops the zone itself.)
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — only voting members feed the zone-carrying links (h47-personal-4)", () => {
  it("passes FramingComparison and ReadAcrossSpectrum no aggregator or niche member", async () => {
    const gov = makeSource({ id: "s-gov", slug: "s-gov", name: "Gov", bias: "pro_government", kind: "outlet" });
    const opp = makeSource({ id: "s-opp", slug: "s-opp", name: "Opp", bias: "opposition", kind: "outlet" });
    const aggregator = makeSource({ id: "s-agg", slug: "s-agg", name: "Onedio", bias: "center", kind: "aggregator" });
    const niche = makeSource({ id: "s-niche", slug: "s-niche", name: "Niş", bias: "opposition", kind: "niche" });
    const members = [
      makeMember("a-gov", gov),
      makeMember("a-agg", aggregator),
      makeMember("a-opp", opp),
      makeMember("a-niche", niche),
    ];
    getClusterDetail.mockResolvedValue({
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members,
      allSources: [gov, opp, aggregator, niche],
      wire: { isWireRedistribution: false, effectiveArticleCount: 4, memberCount: 4 },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    } satisfies ClusterDetail);

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    for (const type of [FramingComparison, ReadAcrossSpectrum]) {
      const el = findElementOfType(tree, type);
      expect(el, String(type)).not.toBeNull();
      const slugs = (el?.props.members as ClusterDetailMember[]).map((m) => m.source.slug);
      expect(slugs).toEqual(["s-gov", "s-opp"]);
    }
  });
});

// ---------------------------------------------------------------------------
// h58-postship-2: the framing comparison said "— bu tarafta sessizlik —" over a
// column a toplayıcı / niş source of that zone had covered (cluster 52f72744:
// İşçi Haber, niche Muhalefet, and Dünya, niche Merkez, sit in the "Toplayıcı /
// niş kaynaklar" block right below it). The page hands FramingComparison the
// zones those non-voting members sit in, and it words the empty column like the
// Manşet Kartı does (#219). Nothing is counted differently.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — framing comparison silence wording (h58-postship-2)", () => {
  const QUALIFIED = "— spektruma sayılan kaynaklardan haber yok —";
  const PLAIN = "— bu tarafta sessizlik —";

  const count = (html: string, needle: string) => html.split(needle).length - 1;

  /** Headline rows in the block: one <li> per voting member, never a non-voting one. */
  const listItems = (html: string) => html.match(/<li[ >]/g) ?? [];

  /** The `<section aria-label="LABEL" ...>` of one zone column of the block. */
  function column(html: string, label: string): string {
    const open = html.indexOf(`<section aria-label="${label}"`);
    if (open === -1) throw new Error(`no column ${label}`);
    return html.slice(open, html.indexOf("</section>", open) + "</section>".length);
  }

  /** The framing block exactly as the page hands it to FramingComparison, as HTML. */
  async function framingHtml(sources: Source[], pro = 0): Promise<{ html: string; props: Record<string, unknown> }> {
    const members = sources.map((s) => makeMember(`a-${s.id}`, s));
    const distribution = emptyDistribution();
    distribution.pro_government = pro;
    getClusterDetail.mockResolvedValue({
      cluster: makeCluster({ bias_distribution: distribution }),
      members,
      allSources: sources,
      wire: { isWireRedistribution: false, effectiveArticleCount: members.length, memberCount: members.length },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    } satisfies ClusterDetail);
    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const el = findElementOfType(tree, FramingComparison);
    expect(el).not.toBeNull();
    return {
      html: renderToStaticMarkup(el as unknown as ReactElement),
      props: (el as { props: Record<string, unknown> }).props,
    };
  }

  const outlets = Array.from({ length: 5 }, (_, i) =>
    makeSource({ id: `s-gov-${i}`, slug: `s-gov-${i}`, name: `Gazete ${i}`, bias: "pro_government", kind: "outlet" }),
  );
  const isciHaber = makeSource({ id: "s-isci", slug: "isci-haber", name: "İşçi Haber", bias: "opposition", kind: "niche" });
  const dunya = makeSource({ id: "s-dunya", slug: "dunya", name: "Dünya", bias: "center", kind: "niche" });
  const haberlerCom = makeSource({ id: "s-haberler", slug: "haberler-com", name: "Haberler.com", bias: "pro_government", kind: "aggregator" });

  it("a 52f72744-shaped cluster: the qualified line in both the Bağımsız and the Muhalefet column, no 'bu tarafta sessizlik' anywhere", async () => {
    const { html } = await framingHtml([...outlets, isciHaber, dunya, haberlerCom], 5);

    expect(count(html, QUALIFIED)).toBe(2);
    expect(column(html, "Bağımsız")).toContain(QUALIFIED);
    expect(column(html, "Muhalefet")).toContain(QUALIFIED);
    expect(count(html, "bu tarafta sessizlik")).toBe(0);
    // The counts are the voting ones: five İktidar headlines, nothing else moved.
    expect(column(html, "İktidar")).toContain("5 manşet");
    expect(column(html, "Bağımsız")).toContain("0 manşet");
    expect(column(html, "Muhalefet")).toContain("0 manşet");
    expect(html).toContain("5 kaynağın kendi manşetleri");
    // No non-voting source fills a column (">Dünya<" is the name as its own text
    // node: a bare "Dünya" would match the heading "Farklı Dünyalar").
    for (const name of ["İşçi Haber", "Dünya", "Haberler.com"]) {
      expect(html).not.toContain(`>${name}<`);
    }
    expect(listItems(html)).toHaveLength(5);
  });

  it("passes the zones of the non-voting members, deduped, as a set (an aggregator in a voted zone adds that zone, harmlessly)", async () => {
    const { props } = await framingHtml([...outlets, isciHaber, dunya, haberlerCom], 5);
    expect(props.nonVotingZones).toBeInstanceOf(Set);
    expect([...(props.nonVotingZones as Set<string>)].sort()).toEqual(["bagimsiz", "iktidar", "muhalefet"]);
  });

  it("a cluster with no non-voting member keeps '— bu tarafta sessizlik —' in both empty columns", async () => {
    const { html, props } = await framingHtml(outlets, 5);
    expect([...(props.nonVotingZones as Set<string>)]).toEqual([]);
    expect(count(html, PLAIN)).toBe(2);
    expect(html).not.toContain("spektruma sayılan kaynaklardan haber yok");
  });

  it("qualifies only the zone the non-voting source sits in: the other empty column still says 'sessizlik'", async () => {
    const { html } = await framingHtml([...outlets, isciHaber], 5);
    expect(column(html, "Muhalefet")).toContain(QUALIFIED);
    expect(column(html, "Muhalefet")).not.toContain("sessizlik");
    expect(column(html, "Bağımsız")).toContain(PLAIN);
    expect(column(html, "Bağımsız")).not.toContain("spektruma sayılan");
  });

  it("two articles of the same niche source change nothing but the (deduped) set", async () => {
    const { html, props } = await framingHtml([...outlets, isciHaber, isciHaber], 5);
    expect([...(props.nonVotingZones as Set<string>)]).toEqual(["muhalefet"]);
    expect(count(html, QUALIFIED)).toBe(1);
    expect(count(html, PLAIN)).toBe(1);
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
    // 6 members, 3 distinct dispatches (a202cbe0): the chip must say so
    // instead of claiming a single source.
    const tree = await renderTree(
      detail({
        isWireRedistribution: true,
        effectiveArticleCount: 3,
        memberCount: 6,
        independentHeadlineCount: 2,
      }),
    );
    const row = findMetaRow(tree)!;
    const group = actionsOf(tree)[0]!;
    const metaText = collectText(row.props.children).join("");
    expect(collectHrefs(row.props.children)).toContain("/metodoloji#tek-kaynak");
    expect(metaText).toContain("2 bağımsız başlık");
    expect(metaText).toContain("Ajans ağırlıklı · 6 haber, 3 farklı metin");
    expect(metaText).not.toContain("Tek kaynaktan");
    const actionText = collectText(group.props.children).join("");
    expect(actionText).not.toContain("bağımsız başlık");
    expect(actionText).not.toContain("Ajans ağırlıklı");
    expect(collectHrefs(group.props.children)).not.toContain("/metodoloji#tek-kaynak");
  });

  it("says 'Tek kaynaktan dağıtıldı' only when every member is a copy of one text", async () => {
    const tree = await renderTree(
      detail({
        isWireRedistribution: true,
        effectiveArticleCount: 1,
        memberCount: 5,
      }),
    );
    const row = findMetaRow(tree)!;
    const metaText = collectText(row.props.children).join("");
    expect(metaText).toContain("Tek kaynaktan dağıtıldı · 5 kopya");
    expect(metaText).not.toContain("Ajans ağırlıklı");
  });

  it("titles the wire chip by what is true: all copies of one text vs at least half copies", async () => {
    const single = await renderTree(
      detail({ isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 5 }),
    );
    const multi = await renderTree(
      detail({ isWireRedistribution: true, effectiveArticleCount: 3, memberCount: 6 }),
    );
    const chipTitles = (tree: unknown) =>
      findAllElements(
        tree,
        (el) =>
          typeof el.props.title === "string" &&
          el.props.title.startsWith("Bu kümedeki haberlerin"),
      ).map((el) => el.props.title);

    expect(chipTitles(single)).toEqual([
      "Bu kümedeki haberlerin tamamı aynı ajans metninin kopyası",
    ]);
    expect(chipTitles(multi)).toEqual([
      "Bu kümedeki haberlerin en az yarısı başka bir haberin birebir kopyası",
    ]);
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

  it("marks the Düzeltme talebi link nofollow and non-prefetching (h31-bots-1: one static page behind ~31.7k per-cluster URLs)", async () => {
    const tree = await renderTree();
    const link = findAllElements(
      tree,
      (el) => el.props.href === "/metodoloji?cluster=c1#duzeltme",
    );
    expect(link).toHaveLength(1);
    expect(link[0]!.props.rel).toBe("nofollow");
    expect(link[0]!.props.prefetch).toBe(false);
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
    // An archived cluster keeps its real headline and is never a 404.
    expect(metadata.title).toBe("Test kümesi");
    expect(notFound).not.toHaveBeenCalled();
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

// h31-seo-1: ~71% of new clusters are single-article. The sitemaps, the news
// sitemap and IndexNow already require article_count >= 2; the page itself
// must not offer a thin one-outlet duplicate to the index either. The page
// keeps answering 200 with its own canonical and JSON-LD (shared links work).
describe("generateMetadata — single-article clusters are noindex (h31-seo-1)", () => {
  function detailWithCount(articleCount: number, isArchived = false): ClusterDetail {
    const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
    return {
      cluster: makeCluster({
        bias_distribution: emptyDistribution(),
        is_archived: isArchived,
        article_count: articleCount,
      }),
      members: [makeMember("a1", source)],
      allSources: [source],
      wire: { isWireRedistribution: false, effectiveArticleCount: articleCount, memberCount: articleCount },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  it("article_count 1: robots index:false, follow:true, canonical still the cluster itself", async () => {
    getClusterDetail.mockResolvedValue(detailWithCount(1));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
    expect(metadata.openGraph?.url).toBe("/cluster/c1");
    // A real page, not a 404, and the real headline.
    expect(metadata.title).toBe("Test kümesi");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("article_count 0 (no member yet) is noindex too", async () => {
    getClusterDetail.mockResolvedValue(detailWithCount(0));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("article_count 2: robots left unset so the root layout default (index, follow) applies", async () => {
    getClusterDetail.mockResolvedValue(detailWithCount(2));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
  });

  it("a larger cluster stays indexable", async () => {
    getClusterDetail.mockResolvedValue(detailWithCount(12));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toBeUndefined();
  });

  it.each([1, 2, 12])("an archived cluster with article_count %i is noindex, as before", async (count) => {
    getClusterDetail.mockResolvedValue(detailWithCount(count, true));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
  });

  it("the page of a single-article cluster still renders its JSON-LD (only the index hint changes)", async () => {
    getClusterDetail.mockResolvedValue(detailWithCount(1));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findJsonLd(tree)).not.toBeNull();
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

type SlotNode = { type?: unknown; props?: Record<string, unknown> };

/**
 * The `<Suspense>` element whose only child is the named async component.
 * The page keeps ClusterThreadSlot / ClusterFactCheckSlot module-private (a
 * page file only exports the route API), so they are located by function name.
 */
function findSuspenseAround(node: unknown, componentName: string): SlotNode | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSuspenseAround(child, componentName);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as SlotNode;
    if (el.type === Suspense) {
      const child = el.props?.children as SlotNode | undefined;
      if (
        typeof child?.type === "function" &&
        (child.type as { name?: string }).name === componentName
      ) {
        return el;
      }
    }
    if (el.props?.children !== undefined) {
      return findSuspenseAround(el.props.children, componentName);
    }
  }
  return null;
}

/** Awaits the named async slot the way React would, with the props it was given. */
async function renderSlot(tree: unknown, componentName: string): Promise<unknown> {
  const child = findSuspenseAround(tree, componentName)?.props?.children as
    | SlotNode
    | undefined;
  if (!child || typeof child.type !== "function") {
    throw new Error(`no <Suspense> around ${componentName}`);
  }
  return (child.type as (props: unknown) => Promise<unknown>)(child.props);
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
    // The absent zone has a plotted non-voting point (the Haberler.com
    // aggregator), so the absence line is the qualified one (h43-blindspots-1):
    // "no source counted toward the spectrum", not "no source at all". One
    // toContain covers both the role=img aria-label and the summary <p>.
    expect(html).toContain(
      "İlk: CNN Türk · 09:05 — Spektruma sayılan bağımsız kaynaklardan bu kümede haber yok — Muhalefet 2 sa 17 dk sonra katıldı",
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
    const slot = await renderSlot(tree, "ClusterFactCheckSlot");
    expect(getClusterFactChecks).toHaveBeenCalledWith("c1");

    const el = findElementOfType(slot, FactCheckBox);
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
    const slot = await renderSlot(tree, "ClusterFactCheckSlot");
    expect(slot).toBeNull();
    expect(hasElementOfType(tree, FactCheckBox)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Bu konuda doğrulama");
  });

  it("hunt-27: the slot sits in its own null-fallback Suspense and the page body never calls the fetcher", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    const boundary = findSuspenseAround(tree, "ClusterFactCheckSlot");
    expect(boundary).not.toBeNull();
    expect(boundary?.props?.fallback).toBeNull();
    expect(getClusterFactChecks).not.toHaveBeenCalled();
  });

  it("hunt-27: a fact-check read that never settles cannot hold the article", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());
    getClusterFactChecks.mockImplementation(() => new Promise(() => {}));

    // Resolves although the fetcher never does: the page does not await it.
    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findSuspenseAround(tree, "ClusterFactCheckSlot")).not.toBeNull();
    expect(collectText(tree).join(" ")).toContain("Test kümesi");
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
    const slot = await renderSlot(tree, "ClusterThreadSlot");
    expect(getPublishedThreadForCluster).toHaveBeenCalledWith("c1");

    const el = findElementOfType(slot, ThreadLink);
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
    const slot = await renderSlot(tree, "ClusterThreadSlot");
    expect(slot).toBeNull();
    expect(hasElementOfType(tree, ThreadLink)).toBe(false);
    expect(collectText(tree).join("")).not.toContain("Bu hikayenin devamı");
  });

  it("hunt-27: the slot sits in its own null-fallback Suspense and the page body never calls the fetcher", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    const boundary = findSuspenseAround(tree, "ClusterThreadSlot");
    expect(boundary).not.toBeNull();
    expect(boundary?.props?.fallback).toBeNull();
    expect(getPublishedThreadForCluster).not.toHaveBeenCalled();
  });

  it("hunt-27: a thread read that never settles cannot hold the article", async () => {
    getClusterDetail.mockResolvedValue(simpleDetail());
    getPublishedThreadForCluster.mockImplementation(() => new Promise(() => {}));

    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });

    expect(findSuspenseAround(tree, "ClusterThreadSlot")).not.toBeNull();
  });
});

describe("cluster/[id]/page.tsx source — optional widgets stay out of the article's await chain (hunt-27)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "page.tsx"), "utf8");

  /** Blanks // and block comments (offsets kept) so prose cannot trip a match. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
        p1 + " ".repeat(m.length - p1.length),
      );
  }
  const code = stripComments(raw);

  it("no longer awaits the two fetchers together before the body", () => {
    expect(code).not.toMatch(/await\s+Promise\.all\(\s*\[\s*getClusterFactChecks/);
    expect(code).not.toMatch(/const\s+\[\s*factChecks\s*,\s*thread\s*\]/);
  });

  it("calls each fetcher only inside its own module-private async slot", () => {
    for (const [slot, fetcher] of [
      ["ClusterThreadSlot", "getPublishedThreadForCluster"],
      ["ClusterFactCheckSlot", "getClusterFactChecks"],
    ] as const) {
      expect(code).toContain(`async function ${slot}(`);
      expect(code).not.toContain(`export async function ${slot}`);
      expect(code).not.toContain(`export function ${slot}`);
      const start = code.indexOf(`async function ${slot}`);
      const end = code.indexOf("\n}\n", start);
      const body = code.slice(start, end + 2);
      expect(body).toContain(`await ${fetcher}(id)`);
      // The fetcher is called exactly once in the file: inside its slot.
      expect(code.split(`${fetcher}(`).length - 1).toBe(1);
    }
  });

  it("renders each slot inside <Suspense fallback={null}>", () => {
    expect(code).toMatch(
      /<Suspense fallback=\{null\}>\s*<ClusterThreadSlot id=\{id\} \/>\s*<\/Suspense>/,
    );
    expect(code).toMatch(
      /<Suspense fallback=\{null\}>\s*<ClusterFactCheckSlot id=\{id\} \/>\s*<\/Suspense>/,
    );
  });

  // İlgili haberler (h31-seo-1 follow-up): the related-stories slot obeys the
  // same rules as the two above, plus its whole body is guarded.
  it("related stories: the slot is module-private and each feed fetcher is called once, inside it", () => {
    expect(code).toContain("async function ClusterRelatedSlot(");
    expect(code).not.toContain("export async function ClusterRelatedSlot");
    expect(code).not.toContain("export function ClusterRelatedSlot");
    const start = code.indexOf("async function ClusterRelatedSlot");
    const end = code.indexOf("\n}\n", start);
    const body = code.slice(start, end + 2);
    for (const fetcher of ["getTopicClusters", "getPoliticsClusters"] as const) {
      expect(body).toContain(`await ${fetcher}(`);
      // Exactly one call in the whole file: inside the slot.
      expect(code.split(`${fetcher}(`).length - 1).toBe(1);
    }
    // The WHOLE body is in try/catch: nothing may reach error.tsx.
    const tryAt = body.indexOf("try {");
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(body.indexOf("relatedFeedFor("));
    expect(tryAt).toBeLessThan(body.indexOf("await getTopicClusters("));
    expect(body.indexOf("catch")).toBeGreaterThan(body.indexOf("await getPoliticsClusters("));
    expect(body).toContain('console.warn("[cluster-related] omitted:"');
  });

  it("related stories: the slot renders last inside <Suspense fallback={null}>", () => {
    expect(code).toMatch(/<Suspense fallback=\{null\}>\s*<ClusterRelatedSlot/);
  });

  it("related stories: one indexability helper feeds both the robots tag and the block gate", () => {
    expect(code).toContain("function isIndexableCluster(");
    expect(code).not.toContain("export function isIndexableCluster");
    // The definition and its two call sites (generateMetadata and the page).
    expect(code.split("isIndexableCluster(").length - 1).toBe(3);
  });

  it("related stories: the topic read goes through a per-slug single-flight, after the request scope, inside the try", () => {
    const start = code.indexOf("async function ClusterRelatedSlot");
    const body = code.slice(start, code.indexOf("\n}\n", start) + 2);
    const tryAt = body.indexOf("try {");
    const scopeAt = body.indexOf("await awaitRequestScope()");
    const flightAt = body.indexOf("coalesce(");
    const readAt = body.indexOf("await getTopicClusters(");
    expect(tryAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(tryAt);
    expect(flightAt).toBeGreaterThan(scopeAt);
    expect(readAt).toBeGreaterThan(flightAt);
    // One key per slug: the key space is the six hub slugs, never user input.
    expect(body).toContain("coalesce(`related:konu:${feed.slug}`");
    // The read runs inside the flight and is not the page's own clock read.
    expect(code.split("coalesce(").length - 1).toBe(1);
  });

  it("related stories: the clock is read once, in the per-request body, never in the slot", () => {
    // h47-time-1: ClusterDetailPage stamps the instant it rendered (the ages and
    // the stale-copy notice share it) through currentTimeMs(), the repo's
    // Date.now() wrapper. The related slot still reads no clock: `coalesce`
    // does, after its request-scope await.
    expect(code).not.toContain("Date.now(");
    expect(code.split("currentTimeMs(").length - 1).toBe(1);
    const pageAt = code.indexOf("export default async function ClusterDetailPage");
    expect(pageAt).toBeGreaterThan(-1);
    expect(code.indexOf("currentTimeMs(")).toBeGreaterThan(pageAt);
    const slotStart = code.indexOf("async function ClusterRelatedSlot");
    const slotBody = code.slice(slotStart, code.indexOf("\n}\n", slotStart) + 2);
    expect(slotBody).not.toContain("currentTimeMs(");
  });
});

// ---------------------------------------------------------------------------
// İlgili haberler: a server-rendered block at the END of an indexable cluster
// page, listing up to 5 other recent multi-article clusters on the same topic
// plus a 'Tüm <Konu> haberleri' hub link. It reuses the feeds /konu/<slug>, the
// RSS and the home page already read (no new query). It sits in its own
// null-fallback <Suspense>, so a slow or failed feed can never hold or break
// the article. Single-article, archived and headline-less pages are noindex
// and get no block (they would only add feed reads and no crawl path).
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — İlgili haberler", () => {
  function relatedDetail(
    clusterExtra: Partial<ClusterDetail["cluster"]> = {},
  ): ClusterDetail {
    const sabah = makeSource({ id: "s-sabah", name: "Sabah", bias: "pro_government" });
    const sozcu = makeSource({ id: "s-sozcu", name: "Sözcü", bias: "opposition_leaning" });
    const members = [makeMember("a-sabah", sabah), makeMember("a-sozcu", sozcu)];
    const distribution = emptyDistribution();
    for (const m of members) distribution[m.source.bias] += 1;
    return {
      cluster: {
        ...makeCluster({ bias_distribution: distribution, article_count: members.length }),
        ...clusterExtra,
      },
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

  /** A feed row; `n` sets updated_at (one minute apart) so order is unambiguous. */
  function feedBundle(
    id: string,
    n: number,
    extra: Partial<ClusterBundle["cluster"]> = {},
  ): ClusterBundle {
    return {
      cluster: {
        id,
        title_tr: `Ekonomi haberi ${id}`,
        summary_tr: "",
        bias_distribution: emptyDistribution(),
        is_blindspot: false,
        blindspot_side: null,
        article_count: 3,
        first_published: "2026-11-03T09:00:00.000Z",
        updated_at: `2026-11-03T10:${String(n).padStart(2, "0")}:00.000Z`,
        ...extra,
      },
      articles: [],
      sources: [],
    };
  }

  // Seven rows: the page's own cluster ('c1', the newest) and six others.
  function sevenBundles(): ClusterBundle[] {
    return [
      feedBundle("c1", 30),
      feedBundle("c-a", 1),
      feedBundle("c-b", 2),
      feedBundle("c-c", 3),
      feedBundle("c-d", 4),
      feedBundle("c-e", 5),
      feedBundle("c-f", 6),
    ];
  }

  async function pageTree() {
    return ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
  }

  function markupOf(slot: unknown): string {
    return renderToStaticMarkup(slot as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("topic7 ekonomi: the slot sits in a null-fallback Suspense and the page body never calls the fetcher", async () => {
    getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "ekonomi" }));
    getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

    const tree = await pageTree();

    const boundary = findSuspenseAround(tree, "ClusterRelatedSlot");
    expect(boundary).not.toBeNull();
    expect(boundary?.props?.fallback).toBeNull();
    expect(getTopicClusters).not.toHaveBeenCalled();
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });

  it("topic7 ekonomi: renders the 5 newest other stories with the hub link", async () => {
    getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "ekonomi" }));
    getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

    const tree = await pageTree();
    const slot = await renderSlot(tree, "ClusterRelatedSlot");

    // Page 1 of the /konu/ekonomi feed: the same cache key /konu and RSS use.
    expect(getTopicClusters).toHaveBeenCalledTimes(1);
    expect(getTopicClusters).toHaveBeenCalledWith("ekonomi", 1);
    expect(getPoliticsClusters).not.toHaveBeenCalled();

    const html = markupOf(slot);
    // sevenBundles() holds nothing related to the page headline, so the block is
    // the honest "latest" one (h34-reader-3), never headed "İlgili haberler".
    expect(html).toContain("Ekonomi gündeminde son haberler");
    expect(html).not.toContain("İlgili haberler");
    expect(html).toContain('aria-labelledby="related-stories-heading"');
    expect(html).toContain('id="related-stories-heading"');
    expect(html.split("<li").length - 1).toBe(5);
    // Newest first, the page's own cluster ('c1') and the oldest row left out.
    const expected = ["c-f", "c-e", "c-d", "c-c", "c-b"];
    let from = -1;
    for (const id of expected) {
      const at = html.indexOf(`href="/cluster/${id}"`);
      expect(at).toBeGreaterThan(from);
      from = at;
    }
    expect(html).not.toContain('href="/cluster/c1"');
    expect(html).not.toContain('href="/cluster/c-a"');
    expect(html).toContain("Ekonomi haberi c-f");
    expect(html).toContain("kaynak");
    // The hub link.
    expect(html).toContain('href="/konu/ekonomi"');
    expect(html).toContain("Tüm ekonomi haberleri");
  });

  it("topic7 genel: the 'latest' heading reads 'Genel gündemde son haberler' (not 'Genel gündeminde')", async () => {
    getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "genel" }));
    getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

    const slot = await renderSlot(await pageTree(), "ClusterRelatedSlot");

    expect(getTopicClusters).toHaveBeenCalledWith("genel", 1);
    const html = markupOf(slot);
    expect(html).toContain("Genel gündemde son haberler");
    expect(html).not.toContain("gündeminde");
    expect(html).not.toContain("İlgili haberler");
    expect(html).toContain('href="/konu/genel"');
    expect(html).toContain("Tüm genel haberler");
    expect(html).not.toContain("Genel haberleri");
  });

  it("politika: reads the home feed once, never the topic feed, and links the hub to '/'", async () => {
    getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "politika" }));
    getPoliticsClusters.mockResolvedValue({
      bundles: sevenBundles(),
      breakingBundles: [],
      prefilterCount: 7,
    });

    const tree = await pageTree();
    expect(getPoliticsClusters).not.toHaveBeenCalled();
    const slot = await renderSlot(tree, "ClusterRelatedSlot");

    expect(getPoliticsClusters).toHaveBeenCalledTimes(1);
    // The default 'reader' profile: the same entry the home page reads.
    expect(getPoliticsClusters).toHaveBeenCalledWith();
    expect(getTopicClusters).not.toHaveBeenCalled();

    const html = markupOf(slot);
    expect(html).toContain("Politika gündeminde son haberler");
    expect(html).not.toContain("İlgili haberler");
    expect(html.split("<li").length - 1).toBe(5);
    expect(html).toContain('href="/cluster/c-f"');
    expect(html).not.toContain('href="/cluster/c1"');
    expect(html).toContain('href="/"');
    expect(html).toContain("Tüm politika haberleri");
    expect(html).not.toContain("/konu/politika");
  });

  it.each([
    ["null", { topic7: null }],
    ["undefined (a stale cache entry without the field)", {}],
    ["an unknown value", { topic7: "bogus" }],
    ["a wrong-case value", { topic7: "EKONOMI" }],
  ] as const)("topic7 %s: the slot resolves null and no feed is read", async (_label, extra) => {
    getClusterDetail.mockResolvedValue(relatedDetail({ ...extra }));
    getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

    const tree = await pageTree();
    const slot = await renderSlot(tree, "ClusterRelatedSlot");

    expect(slot).toBeNull();
    expect(getTopicClusters).not.toHaveBeenCalled();
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });

  // Measured on production (2026-11-04, non-archived multi-article clusters
  // updated in the last 7 days): the `category` of a cluster member is the
  // politics-gate flag, only 'politika' (8,556 rows) or 'son_dakika' (633 rows).
  // It never names a topic, so it must not stand in for a null topic7: a Brent
  // oil or climate story with politika-flagged members would get a wrong
  // "Politika konusunda son haberler" block on an indexable page.
  it.each([
    ["politika", ["politika", "politika", "politika"]],
    ["son_dakika", ["son_dakika", "son_dakika"]],
    ["a mix of both", ["politika", "son_dakika", "politika"]],
  ] as const)(
    "topic7 null with %s-flagged members: no block and no feed read (article.category is not a topic)",
    async (_label, categories) => {
      const detail = relatedDetail({ topic7: null });
      detail.members = detail.members.map((m, i) => ({
        ...m,
        article: { ...m.article, category: categories[i % categories.length] },
      })) as ClusterDetail["members"];
      getClusterDetail.mockResolvedValue(detail);
      getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });
      getPoliticsClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

      const tree = await pageTree();
      const slot = await renderSlot(tree, "ClusterRelatedSlot");

      expect(slot).toBeNull();
      expect(getTopicClusters).not.toHaveBeenCalled();
      expect(getPoliticsClusters).not.toHaveBeenCalled();
    },
  );

  describe("a failing or empty feed leaves the article alone", () => {
    it("getTopicClusters answering null (its failure value) resolves the slot to null, with a warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "spor" }));
        getTopicClusters.mockResolvedValue(null);

        const tree = await pageTree();
        await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
        expect(getTopicClusters).toHaveBeenCalledWith("spor", 1);
        expect(warn).toHaveBeenCalledWith(
          "[cluster-related] omitted:",
          "konu feed unavailable",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("getPoliticsClusters rejecting resolves the slot to null, with a warning and no throw", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "politika" }));
        getPoliticsClusters.mockRejectedValue(new Error("politics read failed"));

        const tree = await pageTree();
        await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith(
          "[cluster-related] omitted:",
          "politics read failed",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("getTopicClusters throwing (it should not) is contained too", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "dunya" }));
        getTopicClusters.mockRejectedValue(new Error("boom"));

        const tree = await pageTree();
        await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith("[cluster-related] omitted:", "boom");
      } finally {
        warn.mockRestore();
      }
    });

    it("a non-Error rejection is contained as well", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "politika" }));
        getPoliticsClusters.mockRejectedValue("plain string");

        const tree = await pageTree();
        await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith("[cluster-related] omitted:", "plain string");
      } finally {
        warn.mockRestore();
      }
    });

    it("a feed holding only the page's own cluster resolves the slot to null", async () => {
      getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "ekonomi" }));
      getTopicClusters.mockResolvedValue({
        bundles: [feedBundle("c1", 1)],
        hasMore: false,
        page: 1,
      });

      const tree = await pageTree();
      await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
    });

    it("an empty feed resolves the slot to null", async () => {
      getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "ekonomi" }));
      getTopicClusters.mockResolvedValue({ bundles: [], hasMore: false, page: 1 });

      const tree = await pageTree();
      await expect(renderSlot(tree, "ClusterRelatedSlot")).resolves.toBeNull();
    });

    it("a feed that never settles cannot hold the article", async () => {
      getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "ekonomi" }));
      getTopicClusters.mockImplementation(() => new Promise(() => {}));

      // Resolves although the feed never does: the page does not await it.
      const tree = await pageTree();

      expect(findSuspenseAround(tree, "ClusterRelatedSlot")).not.toBeNull();
      expect(collectText(tree).join(" ")).toContain("Test kümesi");
    });
  });

  // Outage amplification (hunt-30 BP review): getTopicClusters has no
  // single-flight key of its own, so while its cached attempt holds a failed
  // sentinel every view would run its own live read of the heavy embedded
  // select. The slot bounds that locally: one in-flight read per slug, and a
  // RETRY_COOLDOWN_MS negative cooldown after a failed one.
  describe("a failing topic feed is read at most once per slug per outage window", () => {
    const BASE_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Only Date is faked: promises and microtasks keep running normally.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(BASE_MS);
      // Every omission is logged; keep the run quiet.
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
      vi.useRealTimers();
    });

    async function slotFor(topic7: string): Promise<Promise<unknown>> {
      getClusterDetail.mockResolvedValue(relatedDetail({ topic7 }));
      const tree = await pageTree();
      return renderSlot(tree, "ClusterRelatedSlot");
    }

    it("concurrent renders of one slug share ONE in-flight read", async () => {
      let settle: (value: null) => void = () => {};
      getTopicClusters.mockImplementation(
        () => new Promise<null>((resolve) => (settle = resolve)),
      );
      getClusterDetail.mockResolvedValue(relatedDetail({ topic7: "spor" }));
      const tree = await pageTree();

      const renders = Array.from({ length: 8 }, () => renderSlot(tree, "ClusterRelatedSlot"));
      // Let every render reach its read.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(getTopicClusters).toHaveBeenCalledTimes(1);

      settle(null);
      await expect(Promise.all(renders)).resolves.toEqual(Array(8).fill(null));
      expect(getTopicClusters).toHaveBeenCalledTimes(1);
    });

    it("a failed read (null) starts a cooldown: repeat renders inside it do not read again", async () => {
      getTopicClusters.mockResolvedValue(null);

      await expect(slotFor("spor")).resolves.toBeNull();
      expect(getTopicClusters).toHaveBeenCalledTimes(1);

      vi.setSystemTime(BASE_MS + RETRY_COOLDOWN_MS - 1);
      for (let i = 0; i < 5; i++) await expect(slotFor("spor")).resolves.toBeNull();
      expect(getTopicClusters).toHaveBeenCalledTimes(1);
    });

    it("a rejected read starts the same cooldown and is still contained", async () => {
      getTopicClusters.mockRejectedValue(new Error("boom"));

      await expect(slotFor("dunya")).resolves.toBeNull();
      await expect(slotFor("dunya")).resolves.toBeNull();
      expect(getTopicClusters).toHaveBeenCalledTimes(1);
    });

    it("after the cooldown the next render reads again and a recovered feed shows the block", async () => {
      getTopicClusters.mockResolvedValue(null);
      await expect(slotFor("ekonomi")).resolves.toBeNull();
      expect(getTopicClusters).toHaveBeenCalledTimes(1);

      vi.setSystemTime(BASE_MS + RETRY_COOLDOWN_MS + 1);
      getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });
      const slot = await slotFor("ekonomi");

      expect(getTopicClusters).toHaveBeenCalledTimes(2);
      const html = markupOf(slot);
      expect(html).toContain("Ekonomi gündeminde son haberler");
      expect(html).toContain('href="/konu/ekonomi"');
    });

    it("the cooldown is per slug: a failing spor feed does not silence ekonomi", async () => {
      getTopicClusters.mockImplementation(async (slug: string) =>
        slug === "spor" ? null : { bundles: sevenBundles(), hasMore: false, page: 1 },
      );

      await expect(slotFor("spor")).resolves.toBeNull();
      const slot = await slotFor("ekonomi");

      expect(getTopicClusters).toHaveBeenCalledTimes(2);
      expect(getTopicClusters).toHaveBeenNthCalledWith(1, "spor", 1);
      expect(getTopicClusters).toHaveBeenNthCalledWith(2, "ekonomi", 1);
      expect(markupOf(slot)).toContain("Ekonomi gündeminde son haberler");
    });

    it("healthy reads are never cooled down: every render still reads (a cache hit) and shows the block", async () => {
      getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

      for (let i = 0; i < 3; i++) {
        expect(markupOf(await slotFor("ekonomi"))).toContain("Ekonomi gündeminde son haberler");
      }
      expect(getTopicClusters).toHaveBeenCalledTimes(3);
    });

    it("a feed that is up but has nothing related is not a failure and arms no cooldown", async () => {
      getTopicClusters.mockResolvedValue({ bundles: [], hasMore: false, page: 1 });

      await expect(slotFor("ekonomi")).resolves.toBeNull();
      await expect(slotFor("ekonomi")).resolves.toBeNull();
      expect(getTopicClusters).toHaveBeenCalledTimes(2);
    });
  });

  describe("only indexable pages get the block", () => {
    it.each([
      ["a single-article cluster", { topic7: "ekonomi", article_count: 1 }],
      ["an empty cluster", { topic7: "ekonomi", article_count: 0 }],
      ["an archived cluster", { topic7: "ekonomi", is_archived: true }],
      ["a headline-less cluster", { topic7: "ekonomi", title_tr: "&nbsp;" }],
      ["a question-titled cluster (h34-reader-2)", { topic7: "ekonomi", title_tr: "Sarıgül'ün yatak odasındaki sır ne?" }],
      ["an SEO-explainer cluster without a '?' (h34-reader-2)", { topic7: "ekonomi", title_tr: "Saniye Caran kimdir kaç yaşında nereli" }],
    ] as const)("%s has no ClusterRelatedSlot and reads no feed", async (_label, extra) => {
      getClusterDetail.mockResolvedValue(relatedDetail({ ...extra }));
      getTopicClusters.mockResolvedValue({ bundles: sevenBundles(), hasMore: false, page: 1 });

      const tree = await pageTree();

      expect(findSuspenseAround(tree, "ClusterRelatedSlot")).toBeNull();
      expect(getTopicClusters).not.toHaveBeenCalled();
      expect(getPoliticsClusters).not.toHaveBeenCalled();
      expect(collectText(tree).join(" ")).not.toContain("İlgili haberler");
    });

    it("the block gate and the robots tag agree for every case above", async () => {
      const cases: Array<Partial<ClusterDetail["cluster"]>> = [
        { topic7: "ekonomi", article_count: 1 },
        { topic7: "ekonomi", is_archived: true },
        { topic7: "ekonomi", title_tr: "&nbsp;" },
        { topic7: "ekonomi", title_tr: "Saniye Caran kimdir? Korkuteli Belediye Başkanı kaç yaşında, nereli?" },
        { topic7: "ekonomi", article_count: 2 },
      ];
      for (const extra of cases) {
        getClusterDetail.mockResolvedValue(relatedDetail(extra));
        const meta = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
        const tree = await pageTree();
        const noindex = meta.robots !== undefined;
        expect(findSuspenseAround(tree, "ClusterRelatedSlot") === null).toBe(noindex);
      }
    });
  });
});

describe("RelatedStories component", () => {
  const items = [
    { id: "11111111-1111-4111-8111-111111111111", title: "Faiz kararı açıklandı", sourceCount: 12, lang: undefined },
    { id: "22222222-2222-4222-8222-222222222222", title: "Central bank holds rates", sourceCount: 3, lang: "en" as const },
  ];

  function render(over: Partial<Parameters<typeof RelatedStories>[0]> = {}): string {
    return renderToStaticMarkup(
      <RelatedStories
        items={items}
        topicLabel="Ekonomi"
        hubHref="/konu/ekonomi"
        hubLabel="Tüm Ekonomi haberleri"
        {...over}
      />,
    );
  }

  it("is a labelled nav with the h2, the topic line, one li per item and the hub link", () => {
    const html = render();
    expect(html).toContain('<nav aria-labelledby="related-stories-heading"');
    expect(html).toContain('<h2 id="related-stories-heading"');
    expect(html).toContain(">İlgili haberler</h2>");
    expect(html).toContain("Ekonomi konusunda son haberler");
    expect(html.split("<li").length - 1).toBe(2);
    expect(html).toContain('href="/cluster/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/cluster/22222222-2222-4222-8222-222222222222"');
    expect(html).toContain("12 kaynak");
    expect(html).toContain("3 kaynak");
    expect(html).toContain('href="/konu/ekonomi"');
    expect(html).toContain("Tüm Ekonomi haberleri");
  });

  it("marks only the English headline lang=en, and hides the separator dot from assistive tech", () => {
    const html = render();
    expect(html.split('lang="en"').length - 1).toBe(1);
    expect(html).toContain('<span aria-hidden="true">· </span>');
  });

  it("escapes a title instead of injecting it", () => {
    const html = render({
      items: [{ id: "x1", title: '<img src=x onerror="alert(1)">', sourceCount: 2, lang: undefined }],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("gives the hub link a 24 px target (44 px on small screens)", () => {
    const html = render();
    expect(html).toContain("min-h-6");
    expect(html).toContain("max-sm:min-h-11");
  });

  it("has no opacity-based text colour (WCAG 1.4.3)", () => {
    const html = render();
    expect(html).not.toContain("text-muted-foreground/");
    expect(html).not.toContain("text-foreground/");
  });

  // Byte budget: this block is added to every indexable cluster page, so it
  // must stay small. Five rows with 100-character Turkish titles and UUID-style
  // hrefs measure 3225 bytes of static markup (nav through the hub link, no
  // streaming wrapper): about 850 of them are the five identical link class
  // strings, which gzip folds. The ceiling is 3500, so growth is caught but the
  // literal Tailwind classes need no trimming.
  it("stays under the byte budget for 5 rows of 100-character Turkish titles", () => {
    const longTitle =
      "Merkez Bankası politika faizini yüzde kırk beşte sabit tuttu, piyasalarda dalgalanma sürüyor ve dolar".slice(
        0,
        100,
      );
    expect(longTitle).toHaveLength(100);
    const five = Array.from({ length: 5 }, (_, i) => ({
      id: `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`,
      title: longTitle,
      sourceCount: 12,
      lang: undefined,
    }));
    const bytes = Buffer.byteLength(render({ items: five }), "utf8");
    expect(bytes).toBeLessThan(3500);
  });

  it("is a hookless server component (no 'use client', no hooks)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../../../components/story/related-stories.tsx"),
      "utf8",
    );
    expect(src).not.toContain("use client");
    expect(src).not.toMatch(/\buse(State|Effect|Ref|Memo|Callback|Context|Reducer)\b/);
    // Every link is prefetch={false}: two <Link> elements (the row and the hub).
    expect(src.split("<Link").length - 1).toBe(2);
    expect(src.split("prefetch={false}").length - 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A4 — a missing cluster hands its head to not-found.tsx. generateMetadata
// used to answer the null read with a bespoke noindex "Sayfa bulunamadı"
// shell. It now calls notFound() itself, so the head carries the not-found.tsx
// metadata (its own title and description, noindex, no canonical) instead of an
// inherited homepage description. What this does NOT do is change the wire
// status: measured on a production build (see the comment above
// generateMetadata in page.tsx), an unknown valid uuid still answers 200 to
// Googlebot, bingbot, GPTBot and Chrome alike, because the Suspense shell has
// already flushed by the time the DB-backed check resolves. There is no SEO
// regression (noindex stays), but the soft-404 status is NOT fixed here; a wire
// 404 needs an existence check before streaming (an allowlisted anon RPC plus a
// src/middleware.ts edit) and stays an open operator decision. Only the null
// read calls notFound(): a rejected read stays the noindex "yüklenemiyor" shell
// (see "timeout is not a 404" below).
// ---------------------------------------------------------------------------
describe("generateMetadata — missing cluster hands the head to not-found.tsx (A4)", () => {
  it("calls notFound() once on a null read, and generateMetadata rejects with NEXT_NOT_FOUND", async () => {
    getClusterDetail.mockResolvedValue(null);
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      generateMetadata({ params: Promise.resolve({ id: "a202cbe0-0000-0000-0000-000000000000" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("no longer builds the bespoke 'Sayfa bulunamadı' metadata in generateMetadata", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "page.tsx"), "utf8");
    const start = source.indexOf("export async function generateMetadata");
    const end = source.indexOf("export default async function ClusterDetailPage");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    expect(source.slice(start, end)).not.toContain("Sayfa bulunamadı");
  });
});

// ---------------------------------------------------------------------------
// B — mobile "Kaynak künyesi" clipping (browser-qa-6): the <li> and <ul>
// under the "Kaynak künyesi" heading must wrap instead of overflowing.
// ---------------------------------------------------------------------------

/**
 * The page's `<SourceKunye>` expanded one level. It is a synchronous, hookless
 * server component, so calling it with the props the page gave it is exactly
 * what React does; this keeps the künye assertions below on the page -> rows
 * path even though the rows now live in src/components/story/source-kunye.tsx.
 */
function expandKunye(page: unknown): unknown {
  const el = findElementOfType(page, SourceKunye);
  expect(el).not.toBeNull();
  return SourceKunye(el!.props as Parameters<typeof SourceKunye>[0]);
}

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

    const page = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const tree = expandKunye(page);

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

    const page = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const tree = expandKunye(page);
    const kunyeUl = findAllElements(
      tree,
      (el) =>
        el.type === "ul" &&
        typeof el.props.className === "string" &&
        el.props.className.includes("gap-x-3") &&
        el.props.className.includes("min-w-0"),
    )[0];
    return { page, tree, kunyeUl, nicheMember: members[3]! };
  }

  it("hands <SourceKunye> the deduped, rated-only sources in member order", async () => {
    const { page } = await renderKunye();

    const el = findElementOfType(page, SourceKunye);
    expect(el).not.toBeNull();
    const sources = el!.props.sources as Source[];
    expect(sources.map((s) => s.slug)).toEqual(["sabah", "trt-haber"]);
  });

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
    const { page, nicheMember } = await renderKunye();

    const outbound = findAllElements(
      page,
      (el) => el.type === "a" && el.props.href === nicheMember.article.url,
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.props.href).toBe(nicheMember.article.url);
    expect(outbound[0]!.props.target).toBe("_blank");
    expect(outbound[0]!.props.rel).toBe("noopener noreferrer");
  });
});

// ---------------------------------------------------------------------------
// h49-browser-1 — the künye is capped: the page passes the whole rated list to
// <SourceKunye>, which shows KUNYE_VISIBLE rows and folds the rest into a
// native "Tüm künye (N kaynak)" <details>. The row/threshold detail is pinned in
// src/components/story/source-kunye.test.tsx; this is the page wiring.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — Kaynak künyesi is capped (h49-browser-1)", () => {
  async function pageWith(slugs: string[]) {
    const sources = slugs.map((slug) => makeSource({ id: slug, slug, name: `Kaynak ${slug}` }));
    const detail: ClusterDetail = {
      cluster: makeCluster({ bias_distribution: emptyDistribution() }),
      members: sources.map((s, i) => makeMember(`a${i}`, s)),
      allSources: sources,
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: sources.length,
        memberCount: sources.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
    getClusterDetail.mockResolvedValue(detail);
    return ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
  }

  it("passes every rated source to <SourceKunye> and lets it fold the overflow", async () => {
    const slugs = Object.keys(SOURCE_METADATA).slice(0, 9);
    expect(slugs).toHaveLength(9);
    const page = await pageWith(slugs);

    const el = findElementOfType(page, SourceKunye);
    expect(el).not.toBeNull();
    expect((el!.props.sources as Source[]).map((s) => s.slug)).toEqual(slugs);

    const html = renderToStaticMarkup(expandKunye(page) as ReactElement);
    expect(html).toContain("Tüm künye (9 kaynak)");
    expect(html.replace(/<details[\s\S]*<\/details>/, "").match(/<li[\s>]/g)).toHaveLength(
      KUNYE_VISIBLE,
    );
  });

  it("renders a 4-source story as before: four rows, no disclosure", async () => {
    const page = await pageWith(Object.keys(SOURCE_METADATA).slice(0, 4));

    const html = renderToStaticMarkup(expandKunye(page) as ReactElement);
    expect(html.match(/<li[\s>]/g)).toHaveLength(4);
    expect(html).not.toContain("<details");
    expect(html).toContain("Kaynak künyesi");
  });

  it("renders no künye block when no member source is tagged", async () => {
    const page = await pageWith(["untagged-a", "untagged-b"]);

    expect(expandKunye(page)).toBeNull();
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
    expect(metadata.title).toBe("Haber taşındı");
    expect(metadata.alternates?.canonical).toBe(`/cluster/${TARGET}`);
    expect(permanentRedirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
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

    await expect(
      generateMetadata({ params: Promise.resolve({ id: "c1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
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
    // "try again", not "gone": a transient read failure must never become a 404.
    expect(notFound).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// h23-a11y-1 (WCAG 3.1.2 Language of Parts): English-outlet text inside
// <html lang="tr">. Prod cluster fbb078b4-91cb-4534-8bf7-831ea1660e2a is
// all-English ('Erdoğan visits Seoul with $15 billion trade goal'): its member
// sources, read-only from prod on 2026-11-02, are a-news, daily-sabah,
// hurriyet-daily-news and trt-world. The h1 gets lang="en" only when EVERY
// member is an English outlet AND the headline is not the Turkish LLM rewrite.
// ---------------------------------------------------------------------------

/** The first element (depth-first, document order) matching `pred`, or null. */
function findElement(
  node: unknown,
  pred: (el: { type?: unknown; props: Record<string, unknown> }) => boolean,
): { type?: unknown; props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, pred);
      if (found !== null) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (el.props && pred({ type: el.type, props: el.props })) {
      return { type: el.type, props: el.props };
    }
    if (el.props?.children !== undefined) return findElement(el.props.children, pred);
  }
  return null;
}

// Real slugs and display names of fbb078b4's four member sources. The bias
// categories are illustrative (they do not influence lang).
const FBB078B4_SOURCES: Array<{ slug: string; name: string; bias: Source["bias"] }> = [
  { slug: "a-news", name: "A News", bias: "pro_government" },
  { slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government" },
  { slug: "hurriyet-daily-news", name: "Hürriyet Daily News", bias: "center" },
  { slug: "trt-world", name: "TRT World", bias: "state_media" },
];

function langDetail(opts: {
  sources: Array<{ slug: string; name: string; bias: Source["bias"]; kind?: Source["kind"] }>;
  titleMethod?: ClusterDetail["cluster"]["title_method"];
  titleOriginal?: string | null;
  summary?: string;
  /** Index of the member whose article description IS the summary (the seed). */
  seedIndex?: number;
  imageUrlOnFirst?: string | null;
}): ClusterDetail {
  const sources = opts.sources.map((s) =>
    makeSource({ id: `id-${s.slug}`, slug: s.slug, name: s.name, bias: s.bias, kind: s.kind }),
  );
  const members = sources.map((source, i) => {
    const member = makeMember(
      `a-${source.slug}`,
      source,
      `2026-09-06T${String(12 - i).padStart(2, "0")}:00:00.000Z`,
      i === 0 ? (opts.imageUrlOnFirst ?? null) : null,
    );
    if (opts.seedIndex === i && opts.summary !== undefined) {
      member.article.description = opts.summary;
    }
    return member;
  });
  const cluster = makeCluster({
    bias_distribution: emptyDistribution(),
    title_original: opts.titleOriginal ?? null,
    title_method: opts.titleMethod ?? null,
  });
  cluster.title_tr = "Erdoğan Seul'de 15 milyar dolarlık ticaret hedefi açıkladı";
  if (opts.summary !== undefined) cluster.summary_tr = opts.summary;
  return {
    cluster,
    members,
    allSources: sources,
    wire: {
      isWireRedistribution: false,
      effectiveArticleCount: members.length,
      memberCount: members.length,
    },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

async function renderTree(detail: ClusterDetail) {
  getClusterDetail.mockResolvedValue(detail);
  return ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
}

const h1Of = (tree: unknown) => findElement(tree, (el) => el.type === "h1");

describe("ClusterDetailPage — h1 lang for an all-English cluster (h23-a11y-1)", () => {
  it("(a) puts lang=en on the h1 when every member is English and title_method is null", async () => {
    const tree = await renderTree(langDetail({ sources: FBB078B4_SOURCES, titleMethod: null }));
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("(a) puts lang=en on the h1 when every member is English and title_method is 'extractive'", async () => {
    const tree = await renderTree(
      langDetail({
        sources: FBB078B4_SOURCES,
        titleMethod: "extractive",
        titleOriginal: "Erdoğan visits Seoul with $15 billion trade goal",
      }),
    );
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("(a) a single English member is enough for an all-English cluster", async () => {
    const tree = await renderTree(langDetail({ sources: [FBB078B4_SOURCES[1]!] }));
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("(b) leaves the h1 untagged when one member is Turkish", async () => {
    const tree = await renderTree(
      langDetail({
        sources: [...FBB078B4_SOURCES, { slug: "sozcu", name: "Sözcü", bias: "opposition" }],
        titleMethod: "extractive",
        titleOriginal: "Erdoğan visits Seoul with $15 billion trade goal",
      }),
    );
    expect(h1Of(tree)).not.toBeNull();
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("(b) counts a non-voting (aggregator) Turkish member too: textLang spans ALL members", async () => {
    const tree = await renderTree(
      langDetail({
        sources: [
          ...FBB078B4_SOURCES,
          { slug: "haberler-com", name: "Haberler.com", bias: "center", kind: "aggregator" },
        ],
      }),
    );
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("(b) a Turkish-only cluster has no lang on the h1", async () => {
    const tree = await renderTree(
      langDetail({ sources: [{ slug: "sozcu", name: "Sözcü", bias: "opposition" }] }),
    );
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("(c) leaves the h1 untagged for an all-English cluster whose title_method is 'llm' (the rewrite is Turkish)", async () => {
    const tree = await renderTree(
      langDetail({
        sources: FBB078B4_SOURCES,
        titleMethod: "llm",
        titleOriginal: "Erdoğan visits Seoul with $15 billion trade goal",
      }),
    );
    expect(h1Of(tree)).not.toBeNull();
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("(c) tags the 'Özgün başlık' disclosure span lang=en in that same llm case", async () => {
    const original = "Erdoğan visits Seoul with $15 billion trade goal";
    const tree = await renderTree(
      langDetail({ sources: FBB078B4_SOURCES, titleMethod: "llm", titleOriginal: original }),
    );
    const span = findElement(tree, (el) => el.type === "span" && el.props.children === original);
    expect(span).not.toBeNull();
    expect(span?.props.lang).toBe("en");
  });

  it("(c) tags the 'Özgün başlık' span lang=en for an all-English extractive cluster too", async () => {
    const original = "Erdoğan visits Seoul with $15 billion trade goal";
    const tree = await renderTree(
      langDetail({ sources: FBB078B4_SOURCES, titleMethod: "extractive", titleOriginal: original }),
    );
    const span = findElement(tree, (el) => el.type === "span" && el.props.children === original);
    expect(span?.props.lang).toBe("en");
  });

  it("(c) leaves the 'Özgün başlık' span untagged when the cluster is mixed", async () => {
    const original = "Erdoğan visits Seoul with $15 billion trade goal";
    const tree = await renderTree(
      langDetail({
        sources: [...FBB078B4_SOURCES, { slug: "sozcu", name: "Sözcü", bias: "opposition" }],
        titleMethod: "llm",
        titleOriginal: original,
      }),
    );
    const span = findElement(tree, (el) => el.type === "span" && el.props.children === original);
    expect(span).not.toBeNull();
    expect(span?.props.lang).toBeUndefined();
  });

  it("does not tag the neutral Turkish fallback 'Haber' as English on a headline-less English cluster", async () => {
    const detail = langDetail({ sources: FBB078B4_SOURCES });
    detail.cluster.title_tr = "&nbsp";
    const tree = await renderTree(detail);
    expect(findH1Text(tree)).toBe("Haber");
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });
});

describe("ClusterDetailPage — hero image alt is the cluster headline (h23-a11y-1)", () => {
  it("(d) uses the Turkish cluster headline, not a member's English article title", async () => {
    const detail = langDetail({
      sources: FBB078B4_SOURCES,
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    const tree = await renderTree(detail);
    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero).not.toBeNull();
    expect(hero!.src).toBe("https://img.example/hero.jpg");
    expect(hero!.alt).toBe(detail.cluster.title_tr);
    expect(hero!.alt).not.toBe(detail.members[0]!.article.title);
  });

  it("(d) the alt is the headline for a Turkish cluster with an image as well", async () => {
    const detail = langDetail({
      sources: [{ slug: "sozcu", name: "Sözcü", bias: "opposition" }],
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    const tree = await renderTree(detail);
    expect(findPropsOfType(tree, ClusterCardImage)!.alt).toBe(detail.cluster.title_tr);
  });

  it("(f) tags the hero image lang=en for an all-English extractive cluster with a hero photo (fbb078b4)", async () => {
    const detail = langDetail({
      sources: FBB078B4_SOURCES,
      titleMethod: "extractive",
      titleOriginal: "Erdoğan visits Seoul with $15 billion trade goal",
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    detail.cluster.title_tr = "Erdoğan visits Seoul with $15 billion trade goal";
    const tree = await renderTree(detail);
    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero).not.toBeNull();
    expect(hero!.alt).toBe("Erdoğan visits Seoul with $15 billion trade goal");
    expect(hero!.lang).toBe("en");
    // The image shares the <h1>'s language: both carry the same English text.
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("(f) tags the hero image lang=en with no photo too (the logo / placeholder tiers name the image)", async () => {
    const detail = langDetail({ sources: FBB078B4_SOURCES, titleMethod: "extractive" });
    const tree = await renderTree(detail);
    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero).not.toBeNull();
    expect(hero!.lang).toBe("en");
  });

  it("(f) leaves the hero image untagged in a mixed cluster", async () => {
    const detail = langDetail({
      sources: [...FBB078B4_SOURCES, { slug: "sozcu", name: "Sözcü", bias: "opposition" }],
      titleMethod: "extractive",
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    const tree = await renderTree(detail);
    expect(findPropsOfType(tree, ClusterCardImage)!.lang).toBeUndefined();
  });

  it("(f) leaves the hero image untagged when the all-English cluster's headline is the Turkish LLM rewrite", async () => {
    const detail = langDetail({
      sources: FBB078B4_SOURCES,
      titleMethod: "llm",
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    const tree = await renderTree(detail);
    expect(findPropsOfType(tree, ClusterCardImage)!.lang).toBeUndefined();
  });

  it("(f) leaves the hero image untagged for the Turkish 'Haber' fallback on an all-English cluster", async () => {
    const detail = langDetail({
      sources: FBB078B4_SOURCES,
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    detail.cluster.title_tr = "&nbsp";
    const tree = await renderTree(detail);
    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero!.alt).toBe("Haber");
    expect(hero!.lang).toBeUndefined();
  });

  it("(d) still falls back to 'Haber' for a headline-less cluster that has an image", async () => {
    const detail = langDetail({
      sources: FBB078B4_SOURCES,
      imageUrlOnFirst: "https://img.example/hero.jpg",
    });
    detail.cluster.title_tr = "&nbsp";
    const tree = await renderTree(detail);
    expect(findPropsOfType(tree, ClusterCardImage)!.alt).toBe("Haber");
  });
});

describe("ClusterDetailPage — summary paragraph lang follows the seed outlet (h23-a11y-1)", () => {
  const SUMMARY = "Turkish President Erdoğan arrived in Seoul on Monday for a three-day state visit.";

  const summaryParagraph = (tree: unknown, text: string) =>
    findElement(
      tree,
      (el) => el.type === "p" && collectText(el.props.children).join("") === text,
    );

  it("(e) tags the summary <p> lang=en when a Daily Sabah member seeded it", async () => {
    const tree = await renderTree(
      langDetail({
        sources: [FBB078B4_SOURCES[1]!, { slug: "sozcu", name: "Sözcü", bias: "opposition" }],
        summary: SUMMARY,
        seedIndex: 0,
      }),
    );
    const p = summaryParagraph(tree, SUMMARY);
    expect(p).not.toBeNull();
    expect(p?.props.lang).toBe("en");
    expect(collectText(tree).join("")).toContain("Özet — Daily Sabah");
  });

  it("(e) tags the summary lang=en even in a mixed cluster, because the seed decides, not the roster", async () => {
    const tree = await renderTree(
      langDetail({
        sources: [{ slug: "sozcu", name: "Sözcü", bias: "opposition" }, FBB078B4_SOURCES[1]!],
        summary: SUMMARY,
        seedIndex: 1,
      }),
    );
    expect(summaryParagraph(tree, SUMMARY)?.props.lang).toBe("en");
  });

  it("(e) leaves the summary <p> untagged when a Turkish member seeded it", async () => {
    const turkish = "Cumhurbaşkanı Erdoğan pazartesi günü üç günlük resmi ziyaret için Seul'e geldi.";
    const tree = await renderTree(
      langDetail({
        sources: [{ slug: "sozcu", name: "Sözcü", bias: "opposition" }, FBB078B4_SOURCES[1]!],
        summary: turkish,
        seedIndex: 0,
      }),
    );
    const p = summaryParagraph(tree, turkish);
    expect(p).not.toBeNull();
    expect(p?.props.lang).toBeUndefined();
  });

  it("(e) leaves the summary untagged when no member matches the seed ('Kaynak açıklaması')", async () => {
    const tree = await renderTree(
      langDetail({ sources: FBB078B4_SOURCES, summary: SUMMARY }),
    );
    const p = summaryParagraph(tree, SUMMARY);
    expect(p).not.toBeNull();
    expect(p?.props.lang).toBeUndefined();
    expect(collectText(tree).join("")).toContain("Kaynak açıklaması");
  });
});

// ---------------------------------------------------------------------------
// h31-reader-3 v2: the page keeps the seed's summary while it agrees with the
// headline and swaps it for the member that agrees best when it does not (token
// overlap with the neutral title; summary-agreement.ts has the rule). The first
// try, "the newest eligible member", changed 19 of 39 live summaries and 8 of
// them for the worse; this one is replayed over the 60 most recently updated
// multi-article clusters with zero worse rows. The body, the meta description
// and the JSON-LD must name the same outlet.
// ---------------------------------------------------------------------------

describe("ClusterDetailPage — summary follows the headline (h31-reader-3 v2)", () => {
  const TITLE = "Abdul El Sayed ABD'de Senato'ya seçilen ilk Müslüman oldu";
  const SEED_TEXT =
    "Michigan'daki Senato yarışında, Demokratların Müslüman adayı Abdul ElSayed seçimi önde götürüyor.";
  const BIRGUN_TEXT =
    "Abdul El Sayed, Michigan'da Senato seçimini kazanarak ABD Senatosu'na seçilen ilk Müslüman oldu.";
  const CUMHURIYET_TEXT =
    "Abdul El Sayed Michigan'da Senato koltuğunu aldı, ABD Kongresi'ne giren ilk Müslüman Senatör oldu.";
  const OUTLETS: Array<{
    slug: string;
    name: string;
    bias: Source["bias"];
    at: string;
    description: string;
  }> = [
    { slug: "trt-haber", name: "TRT Haber", bias: "state_media", at: "2026-11-04T06:28:00.000Z", description: SEED_TEXT },
    { slug: "sozcu", name: "Sözcü", bias: "opposition", at: "2026-11-04T07:00:00.000Z", description: "Michigan'da Senato yarışında oy sayımı sürüyor, ilk sonuçlar Demokrat adayın lehine görünüyor." },
    { slug: "hurriyet", name: "Hürriyet", bias: "center", at: "2026-11-04T08:00:00.000Z", description: "ABD'de ara seçim sonuçları gelmeye başladı; Michigan Senato koltuğunda Demokratlar önde." },
    { slug: "ntv", name: "NTV", bias: "center", at: "2026-11-04T09:30:00.000Z", description: "Michigan Senato seçimini Abdul El Sayed kazandı, seçim sonuçları resmen açıklandı." },
    { slug: "cumhuriyet", name: "Cumhuriyet", bias: "opposition_leaning", at: "2026-11-04T10:00:00.000Z", description: CUMHURIYET_TEXT },
    { slug: "birgun", name: "BirGün", bias: "opposition", at: "2026-11-04T10:40:00.000Z", description: BIRGUN_TEXT },
  ];

  /** Six outlets, the seed (TRT Haber) the oldest, the headline saying the race was decided. */
  function story(opts: { birgun?: string; title?: string } = {}): ClusterDetail {
    const sources = OUTLETS.map((o) =>
      makeSource({ id: `id-${o.slug}`, slug: o.slug, name: o.name, bias: o.bias, kind: "outlet" }),
    );
    const members = OUTLETS
      .map((o, i) => {
        const m = makeMember(`a-${o.slug}`, sources[i]!, o.at);
        m.article.description = o.slug === "birgun" ? (opts.birgun ?? o.description) : o.description;
        return m;
      })
      .reverse(); // newest first, as the detail query returns them
    const cluster = makeCluster({ bias_distribution: emptyDistribution(), article_count: members.length });
    cluster.title_tr = opts.title ?? TITLE;
    cluster.summary_tr = SEED_TEXT;
    return {
      cluster,
      members,
      allSources: sources,
      wire: {
        isWireRedistribution: false,
        effectiveArticleCount: members.length,
        memberCount: members.length,
      },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  const summaryParagraph = (tree: unknown, text: string) =>
    findElement(tree, (el) => el.type === "p" && collectText(el.props.children).join("") === text);

  it("the seed contradicts the headline: the member that agrees with it is shown, under its own outlet", async () => {
    const tree = await renderTree(story());
    const text = collectText(tree).join("");
    expect(text).toContain("Özet — BirGün");
    expect(text).not.toContain("Özet — TRT Haber");
    expect(summaryParagraph(tree, BIRGUN_TEXT)).not.toBeNull();
    expect(summaryParagraph(tree, SEED_TEXT)).toBeNull();
    expect(text).not.toContain("önde götürüyor");
  });

  it("the seed agrees with the headline: it stays, under the seed's outlet, although a newer member exists", async () => {
    const tree = await renderTree(story({ title: "Michigan'daki Senato yarışında Abdul ElSayed seçimi önde götürüyor" }));
    const text = collectText(tree).join("");
    expect(text).toContain("Özet — TRT Haber");
    expect(text).not.toContain("Özet — BirGün");
    expect(summaryParagraph(tree, SEED_TEXT)).not.toBeNull();
    expect(summaryParagraph(tree, BIRGUN_TEXT)).toBeNull();
  });

  it("a title with no letter or digit has nothing to agree with: the seed stays", async () => {
    const tree = await renderTree(story({ title: "…" }));
    expect(collectText(tree).join("")).toContain("Özet — TRT Haber");
    expect(summaryParagraph(tree, SEED_TEXT)).not.toBeNull();
  });

  it("adds no clock and no time element to the byline", async () => {
    const tree = await renderTree(story());
    expect(collectText(tree).join("")).not.toContain("Özet — BirGün,");
    expect(findElement(tree, (el) => el.type === "time" && el.props.dateTime === "2026-11-04T10:40:00.000Z")).toBeNull();
    expect(findElement(tree, (el) => el.type === "time" && el.props.dateTime === "2026-11-04T06:28:00.000Z")).toBeNull();
  });

  it("the meta description and the JSON-LD description name the same outlet and text as the page", async () => {
    const detail = story();
    const tree = await renderTree(detail);
    const jsonLd = JSON.parse(findJsonLd(tree) ?? "{}") as { description?: string };
    expect(jsonLd.description).toContain("BirGün:");
    expect(jsonLd.description).not.toContain("TRT Haber:");

    getClusterDetailOrThrowSpy.mockReset();
    getClusterDetail.mockResolvedValue(detail);
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(getClusterDetailOrThrowSpy).toHaveBeenCalled();
    expect(metadata.description).toBe(jsonLd.description);
    expect(metadata.description?.startsWith("6 kaynak. BirGün: Abdul El Sayed, Michigan'da Senato")).toBe(true);
  });

  it("the meta description keeps the seed when the headline is contentless, like the body", async () => {
    const detail = story({ title: "…" });
    getClusterDetailOrThrowSpy.mockReset();
    getClusterDetail.mockResolvedValue(detail);
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
    expect(metadata.description?.startsWith("6 kaynak. TRT Haber: Michigan'daki Senato")).toBe(true);
  });

  // The failure modes the newest-member rule produced. None of them may reach the
  // page, whatever their agreement with the headline: the next best member, or
  // the seed, is shown instead.
  const HAZARDS: Array<[string, string]> = [
    ["a feed-cut stub", "Michigan'da Senato seçimini kazanan Abdul El Sayed, ABD'de Senato'ya seçilen ilk Müslüman oldu ve tarihe geç..."],
    ["a teaser question", "Michigan'da ipi göğüsleyerek ABD'de Senato'ya seçilen ilk Müslüman oldu: Abdul El Sayed kimdir?"],
    ["a dateline", "İSTANBUL (Medyascope) – Abdul El Sayed, Michigan'daki Senato yarışını kazanarak ABD'de Senato'ya seçilen ilk Müslüman oldu."],
    [
      "a glued run-on",
      "Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu, ABD'de tarihe geçti.",
    ],
  ];
  it.each(HAZARDS)("the newest member's text being %s: the next best member is shown", async (_label, hazard) => {
    const tree = await renderTree(story({ birgun: hazard }));
    const text = collectText(tree).join("");
    expect(text).not.toContain(hazard);
    expect(text).toContain("Özet — Cumhuriyet");
    expect(summaryParagraph(tree, CUMHURIYET_TEXT)).not.toBeNull();
  });

  it("no literal match: 'Kaynak açıklaması' stays as stored, with no clock and no time element", async () => {
    const detail = story();
    detail.cluster.summary_tr = "Hiçbir üyenin açıklaması olmayan, saklanmış bir özet metni.";
    const tree = await renderTree(detail);
    const text = collectText(tree).join("");
    expect(text).toContain("Özet — Kaynak açıklaması");
    expect(text).not.toContain("Kaynak açıklaması,");
    expect(
      findElement(tree, (el) => el.type === "time" && el.props.dateTime === "2026-11-04T10:40:00.000Z"),
    ).toBeNull();
  });

  it("a rights-blocked-everywhere summary stays hidden", async () => {
    const detail = story();
    const seed = detail.members.find((m) => m.source.slug === "trt-haber")!;
    seed.source = { ...seed.source, excerpt_allowed: false };
    const tree = await renderTree(detail);
    expect(collectText(tree).join("")).not.toContain("Özet —");
  });

  it("a replacement from an outlet that asked not to be excerpted is never shown", async () => {
    const detail = story();
    const birgun = detail.members.find((m) => m.source.slug === "birgun")!;
    birgun.source = { ...birgun.source, excerpt_allowed: false };
    const tree = await renderTree(detail);
    const text = collectText(tree).join("");
    expect(text).not.toContain(BIRGUN_TEXT);
    expect(text).toContain("Özet — Cumhuriyet");
  });
});

// ---------------------------------------------------------------------------
// h34-reader-2 (2026-11-05): the floor pick shipped SEO questions as the neutral
// headline of two-member clusters ("Sarıgül'ün yatak odasındaki sır ne?", "Saniye
// Caran kimdir? ... kaç yaşında, nereli?") and the page served them index,follow.
// A served title that is a question (isQuestionTitle: a '?' or an explainer phrase)
// is now noindex,follow, merged with the archived / headline-less / single-article
// conditions it sits beside. Canonical, og:url and the real headline stay.
// ---------------------------------------------------------------------------

function titledDetail(
  titleTr: string,
  opts: { articleCount?: number; isArchived?: boolean } = {},
): ClusterDetail {
  const source = makeSource({ id: "s1", slug: "s1", name: "Kaynak" });
  const count = opts.articleCount ?? 3;
  const cluster = makeCluster({
    bias_distribution: emptyDistribution(),
    is_archived: opts.isArchived ?? false,
    article_count: count,
  });
  cluster.title_tr = titleTr;
  return {
    cluster,
    members: [makeMember("a1", source)],
    allSources: [source],
    wire: { isWireRedistribution: false, effectiveArticleCount: count, memberCount: count },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

describe("generateMetadata — a question or SEO-explainer headline is noindex,follow (h34-reader-2)", () => {
  it.each([
    ["a '?' headline", "O görüntüler yeniden gündeme geldi: Sarıgül'ün yatak odasındaki sır ne?"],
    [
      "a 'kimdir ... kaç yaşında, nereli?' explainer",
      "Saniye Caran kimdir? Korkuteli Belediye Başkanı Saniye Caran kaç yaşında, nereli?",
    ],
    ["a 'kim elendi' headline", "Masterchef kim elendi, kim gitti?"],
    ["an explainer without a '?'", "Saniye Caran kimdir kaç yaşında nereli"],
    ["a 'ne zaman' headline without a '?'", "Emekli zammı ne zaman yatacak"],
  ])("%s: robots index:false, follow:true; headline, canonical and og:url unchanged", async (_label, titleTr) => {
    getClusterDetail.mockResolvedValue(titledDetail(titleTr));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.title).toBe(titleTr);
    expect(metadata.alternates?.canonical).toBe("/cluster/c1");
    expect(metadata.openGraph?.url).toBe("/cluster/c1");
    expect(notFound).not.toHaveBeenCalled();
  });

  it.each([
    ["an ordinary headline", "Merkez Bankası faizi sabit tuttu"],
    ["a headline with 'ne' and 'zaman' apart", "Ne yapacağız dediler, zaman gösterdi"],
    ["a headline with 'kimdirler'", "Kimdirler diye soranlara yanıt verildi"],
  ])("%s with 2+ articles stays indexable (robots left to the root layout)", async (_label, titleTr) => {
    getClusterDetail.mockResolvedValue(titledDetail(titleTr, { articleCount: 2 }));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });

    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe(titleTr);
  });

  it("merges with the existing conditions, it does not replace them", async () => {
    // A single-article cluster with an ordinary title is still noindex ...
    getClusterDetail.mockResolvedValue(titledDetail("Merkez Bankası faizi sabit tuttu", { articleCount: 1 }));
    expect((await generateMetadata({ params: Promise.resolve({ id: "c1" }) })).robots).toEqual({
      index: false,
      follow: true,
    });
    // ... an archived one too ...
    getClusterDetail.mockResolvedValue(titledDetail("Merkez Bankası faizi sabit tuttu", { isArchived: true }));
    expect((await generateMetadata({ params: Promise.resolve({ id: "c1" }) })).robots).toEqual({
      index: false,
      follow: true,
    });
    // ... and a question title with every other condition met is noindex on its own.
    getClusterDetail.mockResolvedValue(titledDetail("Zam gelecek mi?", { articleCount: 12 }));
    expect((await generateMetadata({ params: Promise.resolve({ id: "c1" }) })).robots).toEqual({
      index: false,
      follow: true,
    });
  });

  it("a question title on an archived or single-article cluster is the same noindex,follow object", async () => {
    for (const detail of [
      titledDetail("Zam gelecek mi?", { isArchived: true }),
      titledDetail("Zam gelecek mi?", { articleCount: 1 }),
    ]) {
      getClusterDetail.mockResolvedValue(detail);
      const metadata = await generateMetadata({ params: Promise.resolve({ id: "c1" }) });
      expect(metadata.robots).toEqual({ index: false, follow: true });
    }
  });

  it("the page source builds the verdict from hasIndexableTitle in the one shared helper", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");
    expect(src).toContain('from "@/lib/seo/indexable-title"');
    const start = src.indexOf("function isIndexableCluster(");
    const body = src.slice(start, src.indexOf("\n}\n", start) + 2);
    expect(body).toContain("hasIndexableTitle({ title_tr: cluster.title_tr })");
    // Still the one definition: the definition and its two call sites.
    expect(src.split("isIndexableCluster(").length - 1).toBe(3);
  });

  it("the month sitemap, the news sitemap and IndexNow apply the same helper (they never list a noindex URL)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "lib", "seo");
    for (const file of ["sitemaps.ts", "indexnow.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).toContain('from "@/lib/seo/indexable-title"');
      expect(src, file).toContain("hasIndexableTitle(");
    }
  });
});

// ---------------------------------------------------------------------------
// h54-editorial-3: an opinion column is not news. The summary of 539e6666 was a
// Hürriyet /yazarlar/ column's lead under a bare "Özet — Hürriyet"; the page now
// says "Özet — Hürriyet · köşe yazısı" when the shown summary's member is a column
// (isOpinionUrl), and a cluster in which EVERY member is a column gets a
// "Köşe yazısı" pill beside the source count. Both are derived from the article
// URLs at read time: no column, no migration.
// ---------------------------------------------------------------------------

describe("ClusterDetailPage — opinion columns (h54-editorial-3)", () => {
  const TITLE = "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı";
  const COLUMN_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı; bu yazıda sözlerin ardındaki siyaseti ve yarattığı tartışmayı ele alıyorum.";
  const NEWS_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri üzerine CHP'den açıklama geldi, sözler siyasette tartışma yarattı.";
  const MIRROR_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı; yazar sözlerin sert tonuna dikkat çekiyor ve gerekçelerini sıralıyor.";

  interface Spec {
    slug: string;
    name: string;
    url: string;
    description: string;
    at: string;
  }
  const HURRIYET: Spec = {
    slug: "hurriyet",
    name: "Hürriyet",
    url: "https://www.hurriyet.com.tr/yazarlar/nedim-sener/utanmazlik-abidesi-43365220",
    description: COLUMN_TEXT,
    at: "2026-11-04T03:07:31.000Z",
  };
  const SABAH: Spec = {
    slug: "sabah",
    name: "Sabah",
    url: "https://www.sabah.com.tr/yazarlar/salih-tuna/2026/11/04/anladiysaniz-bana-da-anlatin",
    description: MIRROR_TEXT,
    at: "2026-11-04T09:00:00.000Z",
  };
  const YENI_AKIT: Spec = {
    slug: "yeni-akit",
    name: "Yeni Akit",
    url: "https://www.yeniakit.com.tr/haber/sarigul-ozel-2031769.html",
    description: NEWS_TEXT,
    at: "2026-11-04T08:14:00.000Z",
  };

  function detailOf(specs: Spec[], summary = COLUMN_TEXT): ClusterDetail {
    const sources = specs.map((s) => makeSource({ id: `id-${s.slug}`, slug: s.slug, name: s.name, kind: "outlet" }));
    const members = specs
      .map((s, i) => {
        const m = makeMember(`a-${s.slug}`, sources[i]!, s.at);
        m.article.url = s.url;
        m.article.description = s.description;
        return m;
      })
      .sort((a, b) => Date.parse(b.article.published_at) - Date.parse(a.article.published_at));
    const cluster = makeCluster({ bias_distribution: emptyDistribution(), article_count: members.length });
    cluster.title_tr = TITLE;
    cluster.summary_tr = summary;
    return {
      cluster,
      members,
      allSources: sources,
      wire: { isWireRedistribution: false, effectiveArticleCount: members.length, memberCount: members.length },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  /** The element whose own text is exactly `text` (the pill, not the row around it). */
  const elementWithText = (tree: unknown, text: string) =>
    findElement(tree, (el) => typeof el.type === "string" && collectText(el.props.children).join("") === text);

  /** The first meta row: the age, the source count and the badges. */
  const metaRow = (tree: unknown) =>
    findElement(
      tree,
      (el) =>
        el.type === "div" &&
        typeof el.props.className === "string" &&
        el.props.className.includes("text-[12px] font-medium text-muted-foreground"),
    );

  it("an opinion summary is labelled 'Özet — <Outlet> · köşe yazısı'", async () => {
    const tree = await renderTree(detailOf([HURRIYET, SABAH]));
    const text = collectText(tree).join("");
    expect(text).toContain("Özet — Hürriyet · köşe yazısı");
  });

  it("a cluster whose every member is a column shows the 'Köşe yazısı' pill beside the source count", async () => {
    const tree = await renderTree(detailOf([HURRIYET, SABAH]));
    const pill = elementWithText(tree, "Köşe yazısı");
    expect(pill).not.toBeNull();
    expect(pill?.type).toBe("span");
    const row = collectText(metaRow(tree)?.props.children).join("");
    expect(row).toMatch(/2 kaynak.*Köşe yazısı/);
  });

  it("a mixed cluster (539e6666: a column and a news rewrite) has no pill, and its summary is the news member's, unlabelled", async () => {
    const tree = await renderTree(detailOf([HURRIYET, YENI_AKIT]));
    const text = collectText(tree).join("");
    expect(elementWithText(tree, "Köşe yazısı")).toBeNull();
    expect(text).toContain("Özet — Yeni Akit");
    expect(text).not.toContain("köşe yazısı");
    expect(text).not.toContain("Özet — Hürriyet");
    expect(findElement(tree, (el) => el.type === "p" && collectText(el.props.children).join("") === NEWS_TEXT)).not.toBeNull();
    expect(findElement(tree, (el) => el.type === "p" && collectText(el.props.children).join("") === COLUMN_TEXT)).toBeNull();
  });

  it("a mixed cluster whose news member cannot replace the column keeps the column's summary, labelled, with no pill", async () => {
    const weak: Spec = { ...YENI_AKIT, description: "CHP'den yeni bir açıklama geldi, ayrıntılar henüz netleşmedi ve konu gündemde." };
    const tree = await renderTree(detailOf([HURRIYET, weak]));
    const text = collectText(tree).join("");
    expect(text).toContain("Özet — Hürriyet · köşe yazısı");
    expect(elementWithText(tree, "Köşe yazısı")).toBeNull();
  });

  it("a news cluster has neither cue", async () => {
    const other: Spec = { ...SABAH, slug: "sozcu", name: "Sözcü", url: "https://www.sozcu.com.tr/sarigul-ozel-p1" };
    const tree = await renderTree(detailOf([YENI_AKIT, other], NEWS_TEXT));
    const text = collectText(tree).join("");
    expect(elementWithText(tree, "Köşe yazısı")).toBeNull();
    expect(text).toContain("Özet — Yeni Akit");
    expect(text).not.toContain("köşe yazısı");
  });

  it("the pill is a plain-token chip: full-contrast text tokens and no computed class names", async () => {
    const tree = await renderTree(detailOf([HURRIYET, SABAH]));
    const className = String(elementWithText(tree, "Köşe yazısı")?.props.className ?? "");
    expect(className).toContain("rounded-full");
    expect(className).not.toMatch(/text-(?:muted-foreground|brand)\/\d+/);
    expect(className).not.toMatch(/[`$]|\{/);
  });

  it("the JSON-LD and the page name the same summary outlet for a mixed cluster", async () => {
    const detail = detailOf([HURRIYET, YENI_AKIT]);
    const tree = await renderTree(detail);
    const jsonLd = JSON.parse(findJsonLd(tree) ?? "{}") as { description?: string };
    expect(jsonLd.description).toContain("Yeni Akit:");
    expect(jsonLd.description).not.toContain("Hürriyet:");
  });
});

// ---------------------------------------------------------------------------
// h57-outbound-1: the share chips (WhatsApp, Telegram, X, Bluesky and the native
// sheet all read ShareButton's `text`) said "Kör nokta: sadece iktidar yazdı"
// for cluster 0b127dc3, whose page lists three toplayıcı / niş sources from other
// zones (son-dakika, isci-haber, haberler-com). The page now hands buildShareText
// its de-duplicated member sources.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — blindspot share text qualifies 'sadece' (h57-outbound-1)", () => {
  const HEAD = "12 kaynak · 9 sınıflandırılmış: %100 iktidar · %0 bağımsız · %0 muhalefet";

  function blindspotMembers(extra: ClusterDetailMember[]): ClusterDetailMember[] {
    const voting = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeMember(`v${i}`, makeSource({ id: `gov-${i}`, bias: "pro_government", kind: "outlet" })),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeMember(`l${i}`, makeSource({ id: `lean-${i}`, bias: "gov_leaning", kind: "outlet" })),
      ),
    ];
    return [...voting, ...extra];
  }

  function detailWith(members: ClusterDetailMember[]): ClusterDetail {
    const distribution = emptyDistribution();
    distribution.pro_government = 6;
    distribution.gov_leaning = 3;
    const cluster = makeCluster({ bias_distribution: distribution, article_count: 12 });
    cluster.is_blindspot = true;
    cluster.blindspot_side = "pro_government";
    return {
      cluster,
      members,
      allSources: [],
      wire: { isWireRedistribution: false, effectiveArticleCount: 12, memberCount: members.length },
      blindspotSuppressed: false,
      blindspotRecallVetoed: false,
    };
  }

  const SON_DAKIKA = makeSource({ id: "son-dakika", name: "Son Dakika", bias: "center", kind: "aggregator" });
  const ISCI_HABER = makeSource({ id: "isci-haber", name: "İşçi Haber", bias: "opposition", kind: "niche" });
  const HABERLER_COM = makeSource({ id: "haberler-com", name: "Haberler.com", bias: "gov_leaning", kind: "aggregator" });

  async function shareTextOf(detail: ClusterDetail): Promise<string> {
    getClusterDetail.mockResolvedValue(detail);
    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    const share = findPropsOfType(tree, ShareButton);
    expect(share).not.toBeNull();
    return String(share!.text);
  }

  it("hands ShareButton 'spektrumda sadece iktidar' for the 0b127dc3-shaped members", async () => {
    const text = await shareTextOf(
      detailWith(
        blindspotMembers([
          makeMember("n1", SON_DAKIKA),
          makeMember("n2", ISCI_HABER),
          makeMember("n3", HABERLER_COM),
        ]),
      ),
    );
    expect(text).toBe(`${HEAD} · Kör nokta: spektrumda sadece iktidar`);
  });

  it("keeps 'sadece iktidar yazdı' for the control (only haberler-com, inside the zone)", async () => {
    const text = await shareTextOf(detailWith(blindspotMembers([makeMember("n3", HABERLER_COM)])));
    expect(text).toBe(`${HEAD} · Kör nokta: sadece iktidar yazdı`);
  });

  it("keeps 'sadece iktidar yazdı' when every member votes", async () => {
    const text = await shareTextOf(detailWith(blindspotMembers([])));
    expect(text).toContain("Kör nokta: sadece iktidar yazdı");
    expect(text).not.toContain("spektrumda");
  });

  it("counts a source once when it wrote several articles, and still qualifies", async () => {
    const text = await shareTextOf(
      detailWith(blindspotMembers([makeMember("n2", ISCI_HABER), makeMember("n2b", ISCI_HABER)])),
    );
    expect(text).toContain("Kör nokta: spektrumda sadece iktidar");
  });

  it("matches the page's own 'Toplayıcı / niş kaynaklar' row: the claim and the row cannot disagree", async () => {
    const detail = detailWith(blindspotMembers([makeMember("n1", SON_DAKIKA), makeMember("n2", ISCI_HABER)]));
    getClusterDetail.mockResolvedValue(detail);
    const tree = await ClusterDetailPage({ params: Promise.resolve({ id: "c1" }) });
    expect(collectText(tree).join("")).toContain("Toplayıcı / niş kaynaklar");
    expect(String(findPropsOfType(tree, ShareButton)!.text)).toContain("spektrumda sadece iktidar");
  });
});

// ---------------------------------------------------------------------------
// h59-english-1: all-English clusters. fbb078b4 ('Erdoğan visits Seoul with $15
// billion trade goal': hurriyet-daily-news, trt-world, daily-sabah, a-news) and
// 26e8abf9 were written only by English-language outlets, so no Bağımsız or
// Muhalefet outlet could have matched them. The page must not claim those zones
// have no coverage; it prints one note, and the JSON-LD says inLanguage 'en'.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — all-English cluster (h59-english-1)", () => {
  const NOTE =
    "Bu hikâyeyi yalnızca İngilizce yayın yapan kaynaklar yazdı. Türkçe haberlerle eşleşmediği için bölge karşılaştırması yapılamıyor.";
  const NOT_COMPARED = "— Türkçe kaynaklarla karşılaştırılmadı —";
  const ABSENCE = [
    "bu kümede haber yok",
    "henüz haber yok",
    "bu tarafta sessizlik",
    "bu tarafta haber yok",
    "spektruma sayılan kaynaklardan haber yok",
    "akışı şu an sorunlu",
  ];
  const EN_HEADLINE = "Erdoğan visits Seoul with $15 billion trade goal";

  // Real slugs, names and biases of fbb078b4's members (read-only prod, 2026-11-07).
  const FIXTURE_A = [
    { slug: "hurriyet-daily-news", name: "Hürriyet Daily News", bias: "gov_leaning" as const },
    { slug: "a-news", name: "A News", bias: "pro_government" as const },
    { slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government" as const },
    { slug: "trt-world", name: "TRT World", bias: "state_media" as const },
  ];
  // 26e8abf9.
  const FIXTURE_B = [
    { slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government" as const },
    { slug: "hurriyet-daily-news", name: "Hürriyet Daily News", bias: "gov_leaning" as const },
    { slug: "a-news", name: "A News", bias: "pro_government" as const },
  ];
  // Controls: a mixed cluster (a-haber + daily-sabah + a Turkish outlet) and a Turkish pro-government cluster.
  const MIXED = [
    { slug: "a-haber", name: "A Haber", bias: "pro_government" as const },
    { slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government" as const },
    { slug: "sabah", name: "Sabah", bias: "pro_government" as const },
  ];
  const TURKISH = [
    { slug: "sabah", name: "Sabah", bias: "pro_government" as const },
    { slug: "yeni-safak", name: "Yeni Şafak", bias: "pro_government" as const },
    { slug: "a-haber", name: "A Haber", bias: "pro_government" as const },
  ];

  function detailOf(
    sources: Array<{ slug: string; name: string; bias: Source["bias"] }>,
    over: { titleMethod?: ClusterDetail["cluster"]["title_method"]; english?: boolean } = {},
  ): ClusterDetail {
    const detail = langDetail({ sources, titleMethod: over.titleMethod ?? "extractive" });
    if (over.english) detail.cluster.title_tr = EN_HEADLINE;
    return detail;
  }

  /** Every text the cluster page prints for the three zone-wording surfaces, as HTML. */
  async function surfaces(detail: ClusterDetail) {
    const tree = await renderTree(detail);
    const html = (type: unknown) => {
      const el = findElementOfType(tree, type);
      return el ? renderToStaticMarkup(el as unknown as ReactElement) : "";
    };
    return {
      tree,
      timeline: html(StoryTimeline),
      readAcross: html(ReadAcrossSpectrum),
      framing: html(FramingComparison),
    };
  }

  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it.each([
    ["A", FIXTURE_A],
    ["B", FIXTURE_B],
  ])("fixture %s: threads the isolation into the timeline, the read-across and the framing block", async (_label, sources) => {
    const { tree } = await surfaces(detailOf(sources));
    expect(findElementOfType(tree, ReadAcrossSpectrum)!.props.languageIsolated).toBe(true);
    expect(findElementOfType(tree, FramingComparison)!.props.languageIsolated).toBe(true);
    const timeline = findElementOfType(tree, StoryTimeline)!.props.timeline as StoryTimelineData;
    expect(timeline.summary).not.toMatch(/haber yok|sorunlu/);
  });

  it.each([
    ["A", FIXTURE_A],
    ["B", FIXTURE_B],
  ])("fixture %s: no surface prints a zone-absence claim, the one note shows once and the not-compared columns show", async (_label, sources) => {
    const { timeline, readAcross, framing } = await surfaces(detailOf(sources));
    for (const html of [timeline, readAcross, framing]) {
      for (const needle of ABSENCE) expect(html).not.toContain(needle);
    }
    // The read-across slot carries the one note; the framing block only prints
    // the not-compared column text (copy-2 / react-h59-3: it used to repeat it).
    expect(readAcross).toContain(NOTE);
    expect(framing).not.toContain(NOTE);
    expect(count(timeline + readAcross + framing, NOTE)).toBe(1);
    expect(count(framing, NOT_COMPARED)).toBe(2);
    // The spectrum bar, the member lists and the zone headings stay.
    expect(framing).toContain(`${sources.length} kaynağın kendi manşetleri`);
    expect(framing).toContain('aria-label="İktidar"');
  });

  it("fixture A does not consult feed health: nothing is worded as an absence", async () => {
    await surfaces(detailOf(FIXTURE_A));
    expect(getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("fixture A keeps the MediaDna block with every member lit", async () => {
    const { tree } = await surfaces(detailOf(FIXTURE_A));
    const dna = findElementOfType(tree, MediaDna);
    expect(dna).not.toBeNull();
    expect([...(dna!.props.highlightSlugs as Set<string>)].sort()).toEqual(
      ["a-news", "daily-sabah", "hurriyet-daily-news", "trt-world"],
    );
  });

  it("fixture A: JSON-LD inLanguage is 'en' when the h1 is the English member headline", async () => {
    const { tree } = await surfaces(detailOf(FIXTURE_A, { english: true }));
    expect(JSON.parse(findJsonLd(tree)!).inLanguage).toBe("en");
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("fixture A: JSON-LD inLanguage stays 'tr-TR' when the headline is the Turkish LLM rewrite", async () => {
    const { tree } = await surfaces(detailOf(FIXTURE_A, { titleMethod: "llm" }));
    expect(JSON.parse(findJsonLd(tree)!).inLanguage).toBe("tr-TR");
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("controls: a mixed cluster keeps today's wording on every surface and inLanguage 'tr-TR'", async () => {
    const { tree, timeline, readAcross, framing } = await surfaces(detailOf(MIXED));
    expect(findElementOfType(tree, ReadAcrossSpectrum)!.props.languageIsolated).toBe(false);
    expect(findElementOfType(tree, FramingComparison)!.props.languageIsolated).toBe(false);
    expect(timeline).toContain("Bağımsız kaynaklardan bu kümede haber yok");
    expect(timeline).toContain("Muhalefet kaynaklarından bu kümede haber yok");
    expect(readAcross).toContain("Muhalefet tarafında henüz haber yok");
    expect(count(framing, "— bu tarafta sessizlik —")).toBe(2);
    for (const html of [timeline, readAcross, framing]) {
      expect(html).not.toContain(NOTE);
      expect(html).not.toContain(NOT_COMPARED);
    }
    expect(JSON.parse(findJsonLd(tree)!).inLanguage).toBe("tr-TR");
  });

  it("controls: a Turkish pro-government cluster keeps today's wording and inLanguage 'tr-TR'", async () => {
    const { tree, timeline, readAcross, framing } = await surfaces(detailOf(TURKISH));
    expect(findElementOfType(tree, ReadAcrossSpectrum)!.props.languageIsolated).toBe(false);
    expect(findElementOfType(tree, FramingComparison)!.props.languageIsolated).toBe(false);
    expect(timeline).toContain("bu kümede haber yok");
    expect(readAcross).toContain("henüz haber yok");
    expect(framing).toContain("bu tarafta sessizlik");
    expect(JSON.parse(findJsonLd(tree)!).inLanguage).toBe("tr-TR");
  });

  it("controls: a mixed cluster still consults feed health for its absent zones", async () => {
    await surfaces(detailOf(MIXED));
    expect(getZoneFeedHealth).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// h59-english-2: 11 live mixed Turkish + English clusters (749b0eea: 'NATO chief
// visits Türkiye ahead of key summit', Daily Sabah + A Haber) show an English
// member's headline as the <h1> with no lang attribute, because the page only set
// it when EVERY member is English. A mixed cluster now tags the <h1> (and the hero
// image alt, which is the same text) with the home card's rule: `headlineLang`,
// 'en' only when an English member's title IS the headline and no Turkish member
// carries it too.
// ---------------------------------------------------------------------------
describe("ClusterDetailPage — h1 lang for a mixed cluster (h59-english-2)", () => {
  const NATO_EN = "NATO chief visits Türkiye ahead of key summit";
  const NATO_TR = "NATO Genel Sekreteri Rutte Türkiye yolcusu: Başkan Erdoğan ile görüşecek";
  const MIXED_SOURCES = [
    { slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government" as const },
    { slug: "a-haber", name: "A Haber", bias: "pro_government" as const },
  ];

  /** 749b0eea-shaped detail: member 0 is the English outlet, member 1 the Turkish one. */
  function mixedDetail(over: {
    titleTr: string;
    enTitle?: string;
    trTitle?: string;
    titleMethod?: ClusterDetail["cluster"]["title_method"];
    sources?: Array<{ slug: string; name: string; bias: Source["bias"]; kind?: Source["kind"] }>;
    image?: boolean;
  }): ClusterDetail {
    const detail = langDetail({
      sources: over.sources ?? MIXED_SOURCES,
      titleMethod: over.titleMethod ?? "extractive",
      imageUrlOnFirst: over.image ? "https://img.example/hero.jpg" : null,
    });
    detail.cluster.title_tr = over.titleTr;
    detail.members[0]!.article.title = over.enTitle ?? NATO_EN;
    if (detail.members[1]) detail.members[1].article.title = over.trTitle ?? NATO_TR;
    return detail;
  }

  it("749b0eea: the h1 is lang=en when title_tr is the Daily Sabah member's title", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN }));
    expect(findH1Text(tree)).toBe(NATO_EN);
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("the hero image shares the h1's language (its alt is the same English text)", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN, image: true }));
    const hero = findPropsOfType(tree, ClusterCardImage);
    expect(hero!.alt).toBe(NATO_EN);
    expect(hero!.lang).toBe("en");
  });

  it("matches the headline once trimmed and whitespace-collapsed, like the home card", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: `  ${NATO_EN}  `, enTitle: NATO_EN.replace(" chief ", "  chief ") }));
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("no lang when a Turkish member has the identical title (the claim is vetoed)", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN, trTitle: NATO_EN }));
    expect(h1Of(tree)).not.toBeNull();
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("no lang when the headline is a Turkish member's title", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_TR }));
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("no lang when the headline matches no member (the existing mixed-cluster case)", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: "Erdoğan Seul'de 15 milyar dolarlık ticaret hedefi açıkladı" }));
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("skipped for the Turkish LLM rewrite, even if the rewrite happens to equal an English member's title", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN, titleMethod: "llm" }));
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("skipped for the hero image too in the LLM case", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN, titleMethod: "llm", image: true }));
    expect(findPropsOfType(tree, ClusterCardImage)!.lang).toBeUndefined();
  });

  it("skipped for the Turkish 'Haber' fallback of a headline-less cluster", async () => {
    const detail = mixedDetail({ titleTr: "&nbsp" });
    const tree = await renderTree(detail);
    expect(findH1Text(tree)).toBe("Haber");
    expect(h1Of(tree)?.props.lang).toBeUndefined();
  });

  it("an English non-voting member counts like any member (the home card's rule is by title, not by vote)", async () => {
    const tree = await renderTree(
      mixedDetail({
        titleTr: NATO_EN,
        sources: [
          { slug: "mfa-turkey", name: "MFA Turkey", bias: "pro_government" as const, kind: "niche" as const },
          { slug: "a-haber", name: "A Haber", bias: "pro_government" as const },
        ],
      }),
    );
    expect(h1Of(tree)?.props.lang).toBe("en");
  });

  it("the JSON-LD of a mixed cluster stays tr-TR even with an English h1", async () => {
    const tree = await renderTree(mixedDetail({ titleTr: NATO_EN }));
    expect(JSON.parse(findJsonLd(tree)!).inLanguage).toBe("tr-TR");
  });

  it("controls: an all-English cluster and a Turkish cluster are unchanged", async () => {
    const english = await renderTree(
      langDetail({ sources: FBB078B4_SOURCES, titleMethod: "extractive" }),
    );
    expect(h1Of(english)?.props.lang).toBe("en");
    const turkish = await renderTree(
      langDetail({ sources: [{ slug: "sozcu", name: "Sözcü", bias: "opposition" }] }),
    );
    expect(h1Of(turkish)?.props.lang).toBeUndefined();
  });

  // react-h59-1: the 'Özgün başlık' disclosure is the seed member's own title,
  // so in a mixed cluster it takes the h1's member rule (headlineLang over the
  // members), not the all-English `textLang`. 749b0eea stores the English seed in
  // title_tr; once a re-pick selects the Turkish title, title_original becomes
  // that English seed and the disclosure shows a full English sentence under
  // html lang=tr (WCAG 3.1.2).
  const originalSpan = (tree: unknown, text: string) =>
    findElement(tree, (el) => el.type === "span" && el.props.children === text);

  it("(a) tags the 'Özgün başlık' span lang=en when it is an English member's title and the h1 is the Turkish one", async () => {
    const detail = mixedDetail({ titleTr: NATO_TR });
    detail.cluster.title_original = NATO_EN;
    const tree = await renderTree(detail);
    expect(h1Of(tree)?.props.lang).toBeUndefined();
    const span = originalSpan(tree, NATO_EN);
    expect(span).not.toBeNull();
    expect(span?.props.lang).toBe("en");
  });

  it("(b) control: no lang on the span when a Turkish member carries the same text (the claim is vetoed)", async () => {
    const detail = mixedDetail({ titleTr: NATO_TR, trTitle: NATO_EN });
    detail.cluster.title_original = NATO_EN;
    const tree = await renderTree(detail);
    const span = originalSpan(tree, NATO_EN);
    expect(span).not.toBeNull();
    expect(span?.props.lang).toBeUndefined();
  });

  it("(c) control: no lang on the span when the original is a Turkish member's title", async () => {
    const detail = mixedDetail({ titleTr: NATO_EN });
    detail.cluster.title_original = NATO_TR;
    const tree = await renderTree(detail);
    const span = originalSpan(tree, NATO_TR);
    expect(span).not.toBeNull();
    expect(span?.props.lang).toBeUndefined();
  });
});
