import { describe, it, expect, vi, beforeEach } from "vitest";

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: (...a: unknown[]) => getPoliticsClusters(...a),
}));
vi.mock("@/lib/clusters/search-query", () => ({ searchClusters: vi.fn() }));
vi.mock("@/components/filters/search-bar", () => ({ SearchBar: () => null }));
vi.mock("@/components/story/cluster-card", () => ({ ClusterCard: () => null }));
vi.mock("@/components/home/new-since-last-visit", () => ({
  NewSinceLastVisit: () => null,
}));
vi.mock("@/components/ui/retry-button", () => ({ RetryButton: () => null }));

import { generateMetadata } from "@/app/page";

const feed = (n: number) => ({
  bundles: Array.from({ length: n }, (_, i) => ({ cluster: { id: `c${i}` } })),
  breakingBundles: [],
});
const sp = (o: { q?: string | string[]; page?: string | string[] }) => ({
  searchParams: Promise.resolve(o),
});

beforeEach(() => {
  getPoliticsClusters.mockReset();
  getPoliticsClusters.mockResolvedValue(feed(20));
});

describe("home generateMetadata", () => {
  it("inherits the layout canonical for no params, page=1, page=abc and q+page", async () => {
    expect(await generateMetadata(sp({}))).toEqual({});
    expect(await generateMetadata(sp({ page: "1" }))).toEqual({});
    expect(await generateMetadata(sp({ page: "abc" }))).toEqual({});
  });

  it("marks every search noindex,follow with its own title and nothing else (canonical stays the layout's)", async () => {
    const search = (title: string) => ({
      title,
      robots: { index: false, follow: true },
    });
    expect(await generateMetadata(sp({ q: "x" }))).toEqual(search("“x” araması"));
    expect(await generateMetadata(sp({ q: ["x", "y"] }))).toEqual(
      search("“x” araması"),
    );
    expect(await generateMetadata(sp({ q: "x", page: "2" }))).toEqual(
      search("“x” araması"),
    );
    expect(await generateMetadata(sp({ q: ["x", "y"], page: ["2"] }))).toEqual(
      search("“x” araması"),
    );
    expect(await generateMetadata(sp({ q: "seçim erdoğan" }))).toEqual(
      search("“seçim erdoğan” araması"),
    );
    // The title uses the trimmed q, same as the page does.
    expect(await generateMetadata(sp({ q: [" x "] }))).toEqual(
      search("“x” araması"),
    );
    expect(await generateMetadata(sp({ q: "  x  " }))).toEqual(
      search("“x” araması"),
    );
  });

  it("caps a very long q in the title at 60 code points and keeps markup as plain text", async () => {
    const long = await generateMetadata(sp({ q: "a".repeat(300) }));
    expect(long.title).toBe(`“${"a".repeat(59)}…” araması`);
    expect(long.robots).toEqual({ index: false, follow: true });

    const markup = await generateMetadata(sp({ q: "<script>" }));
    expect(markup.title).toBe("“<script>” araması");
  });

  it("gives a search no canonical or RSS alternate of its own, and a no-q page no title", async () => {
    for (const q of ["x", ["x", "y"]]) {
      const md = await generateMetadata(sp({ q, page: "2" }));
      expect(md).not.toHaveProperty("alternates");
    }
    expect(await generateMetadata(sp({}))).not.toHaveProperty("title");
    expect(await generateMetadata(sp({ page: "2" }))).not.toHaveProperty("title");
  });

  it("does not return alternates for a search, so the layout canonical applies", async () => {
    const md = await generateMetadata(sp({ q: "x", page: "2" }));
    expect(md.alternates).toBeUndefined();
  });

  it("treats a blank q as no search: page 2 still gets its self-canonical", async () => {
    const blanks: (string | string[])[] = ["  ", [""], ["  "], []];
    for (const q of blanks) {
      const md = await generateMetadata(sp({ q, page: "2" }));
      expect(md.robots).toBeUndefined();
      expect(md.alternates?.canonical).toBe("/?page=2");
    }
  });

  it("does not make a blank q noindex on page 1", async () => {
    expect(await generateMetadata(sp({ q: "   " }))).toEqual({});
    expect(await generateMetadata(sp({ q: [] }))).toEqual({});
  });

  it("uses the first q of an array: a blank first value is not a search", async () => {
    expect(await generateMetadata(sp({ q: ["", "x"] }))).toEqual({});
  });

  it("is self-canonical for page 2 with 20 ranked bundles and keeps the RSS alternate", async () => {
    const md = await generateMetadata(sp({ page: "2" }));
    expect(md.alternates?.canonical).toBe("/?page=2");
    expect(md.alternates?.types).toEqual({
      "application/rss+xml": [{ url: "/rss.xml", title: "Tayf — Haberler RSS" }],
    });
  });

  it("inherits when page 2 does not exist (10 bundles)", async () => {
    getPoliticsClusters.mockResolvedValue(feed(10));
    expect(await generateMetadata(sp({ page: "2" }))).toEqual({});
  });

  it("clamps an out-of-range page", async () => {
    getPoliticsClusters.mockResolvedValue(feed(10));
    expect(await generateMetadata(sp({ page: "9" }))).toEqual({});
    getPoliticsClusters.mockResolvedValue(feed(20));
    const md = await generateMetadata(sp({ page: "9" }));
    expect(md.alternates?.canonical).toBe("/?page=2");
  });

  it("excludes breaking bundles from the ranked count", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: feed(16).bundles,
      breakingBundles: [{ cluster: { id: "c0" } }],
    });
    expect(await generateMetadata(sp({ page: "2" }))).toEqual({});
  });

  it("returns {} instead of throwing when the feed rejects", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    expect(await generateMetadata(sp({ page: "2" }))).toEqual({});
  });

  it("does not hit the feed for page 1 or a search", async () => {
    await generateMetadata(sp({}));
    await generateMetadata(sp({ q: "x", page: "2" }));
    await generateMetadata(sp({ q: ["x", "y"], page: "2" }));
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });
});
