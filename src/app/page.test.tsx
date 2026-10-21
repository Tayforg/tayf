import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// seo-error-states A.2: "/" must NEVER emit <meta name="robots"
// content="noindex">, not even in the FeedUnavailable retry state. That state
// is a transient cold-read timeout and "/" is the most-crawled URL; a noindex
// seen during a blip would drop the homepage from the index (see page.tsx).
//
// NOTE: these assertions walk the React element tree. They pin WHICH states
// carry the tag, not WHERE it lands in the final document: HomeFeed streams
// behind <Suspense>, so the tag is emitted in <body>, not <head> (see the
// placement caveat in page.tsx).
//
// `HomeFeed` is the streamed, data-dependent body of the page (the same
// pattern as BlindspotsFeed in blindspots/page.tsx): it is exported so this
// suite can call it directly instead of needing a Suspense-aware renderer.
// ---------------------------------------------------------------------------

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: () => getPoliticsClusters(),
}));

const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => searchClusters(q),
}));

import { HomeFeed } from "./page";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Collects every element in the tree (props.children walked recursively). */
function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) {
      collectElements(el.props.children, out);
    }
  }
  return out;
}

function hasNoindexMeta(tree: unknown): boolean {
  return collectElements(tree).some(
    (el) =>
      el.type === "meta" &&
      el.props?.name === "robots" &&
      el.props?.content === "noindex",
  );
}

beforeEach(() => {
  getPoliticsClusters.mockReset();
  searchClusters.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("HomeFeed — never emits noindex", () => {
  it("does not emit noindex when the politics feed fails to load", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));

    const tree = (await HomeFeed({
      searchParams: Promise.resolve({}),
    })) as Elementish;

    expect(hasNoindexMeta(tree)).toBe(false);
    // Still the retry state: NewSinceLastVisit + FeedUnavailable.
    expect(tree.props?.children as Elementish[]).toHaveLength(2);
  });

  it("does not emit noindex when the feed loads but is empty", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);

    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });

    expect(hasNoindexMeta(tree)).toBe(false);
  });

  it("does not emit noindex on a search page when the feed is healthy", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);
    searchClusters.mockResolvedValue({ ok: false });

    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "seçim" }),
    });

    expect(hasNoindexMeta(tree)).toBe(false);
  });
});
