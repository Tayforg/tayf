import { beforeEach, describe, expect, it, vi } from "vitest";

// h55-personal-3: the home "N yeni haber" pill stamps the last visit only on a
// render that actually showed the feed. HomeFeed is called directly (the same
// pattern as page.test.tsx) and the stamp prop of the NewSinceLastVisit element
// is read off the returned tree. The effect that writes localStorage needs a
// browser; the prop is what decides whether it writes.

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: () => getPoliticsClusters(),
}));

const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => searchClusters(q),
}));

import { HomeFeed } from "./page";
import { NewSinceLastVisit } from "@/components/home/new-since-last-visit";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collectElements(el.props.children, out);
  }
  return out;
}

function bundle(id: string) {
  const at = "2026-10-31T10:00:00.000Z";
  return {
    cluster: { id, title_tr: `Haber ${id}`, first_published: at, updated_at: at },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

function feedOf(n: number) {
  return {
    bundles: Array.from({ length: n }, (_, i) => bundle(`b${i + 1}`)),
    breakingBundles: [],
  } as unknown as PoliticsClustersResult;
}

/** The single NewSinceLastVisit mount of one HomeFeed render. */
async function pill(searchParams: { q?: string | string[]; page?: string | string[] }) {
  const tree = await HomeFeed({ searchParams: Promise.resolve(searchParams) });
  const mounts = collectElements(tree).filter((el) => el.type === NewSinceLastVisit);
  expect(mounts).toHaveLength(1);
  return mounts[0]!.props as { stamp: unknown; timestamps: string[] };
}

beforeEach(() => {
  getPoliticsClusters.mockReset();
  searchClusters.mockReset();
  searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("HomeFeed -> NewSinceLastVisit stamp", () => {
  it("stamps on the plain home feed", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    const props = await pill({});
    expect(props.stamp).toBe(true);
    expect(props.timestamps).toHaveLength(3);
  });

  it("stamps on an explicit ?page=1 and on a blank ?q=", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ page: "1" })).stamp).toBe(true);
    expect((await pill({ q: "   " })).stamp).toBe(true);
  });

  it("does not stamp the FeedUnavailable shell (the reader saw no stories)", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const props = await pill({});
    expect(props.stamp).toBe(false);
    expect(props.timestamps).toEqual([]);
  });

  it("does not stamp a /?q= search view", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ q: "seçim" })).stamp).toBe(false);
    // The first value of a repeated ?q= decides, like the rest of the page.
    expect((await pill({ q: ["seçim", "ekonomi"] })).stamp).toBe(false);
  });

  it("does not stamp the unavailable shell of a search either", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    expect((await pill({ q: "seçim" })).stamp).toBe(false);
  });

  it("does not stamp ?page=2", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ page: "2" })).stamp).toBe(false);
  });

  it("judges the CLAMPED page: ?page=99 on a one-page feed is page 1 and stamps", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ page: "99" })).stamp).toBe(true);
  });

  it("?page=99 on a three-page feed clamps to page 3 and does not stamp", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ page: "99" })).stamp).toBe(false);
  });

  it("a search on page 2 does not stamp", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ q: "haber", page: "2" })).stamp).toBe(false);
  });
});
