import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: vi.fn(),
  };
});

import { generateMetadata } from "@/app/konu/[slug]/page";
import { getTopicClusters } from "@/lib/clusters/topic-query";

// Default: a non-empty page, so the canonical tests below see an indexable
// page (no robots override) regardless of the page number they ask for.
beforeEach(() => {
  vi.mocked(getTopicClusters).mockReset();
  vi.mocked(getTopicClusters).mockResolvedValue({
    bundles: [{}],
    page: 1,
    hasMore: false,
  } as never);
});

function req(slug: string, sayfa?: string | string[]) {
  return {
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({ sayfa }),
  };
}

describe("/konu/[slug] generateMetadata — paginated canonical (G)", () => {
  it("is self-canonical with no ?sayfa= for page 1 / undefined", async () => {
    const meta = await generateMetadata(req("dunya", undefined));
    expect(meta.alternates?.canonical).toBe("/konu/dunya");
  });

  it("appends ?sayfa=2 for page 2", async () => {
    const meta = await generateMetadata(req("dunya", "2"));
    expect(meta.alternates?.canonical).toBe("/konu/dunya?sayfa=2");
  });

  it("takes the first value of a repeated ?sayfa=", async () => {
    const meta = await generateMetadata(req("dunya", ["3", "9"]));
    expect(meta.alternates?.canonical).toBe("/konu/dunya?sayfa=3");
  });

  it("clamps an out-of-range page to TOPIC_MAX_PAGE (20)", async () => {
    const meta = await generateMetadata(req("dunya", "999"));
    expect(meta.alternates?.canonical).toBe("/konu/dunya?sayfa=20");
  });

  it("falls back to page 1 for a non-numeric or zero sayfa", async () => {
    const abc = await generateMetadata(req("dunya", "abc"));
    expect(abc.alternates?.canonical).toBe("/konu/dunya");

    const zero = await generateMetadata(req("dunya", "0"));
    expect(zero.alternates?.canonical).toBe("/konu/dunya");
  });

  it("still carries the RSS alternate type", async () => {
    const meta = await generateMetadata(req("dunya", "2"));
    expect(meta.alternates?.types).toEqual({
      "application/rss+xml": "/rss/dunya.xml",
    });
  });

  it("returns {} for politika and an unknown slug", async () => {
    expect(await generateMetadata(req("politika"))).toEqual({});
    expect(await generateMetadata(req("bilinmeyen"))).toEqual({});
  });

  it("never reads the topic feed for politika or an unknown slug", async () => {
    await generateMetadata(req("politika"));
    await generateMetadata(req("bilinmeyen"));
    expect(getTopicClusters).not.toHaveBeenCalled();
  });
});

describe("/konu/[slug] generateMetadata — noindex past the last page", () => {
  it("noindexes (follow kept) an empty page 2", async () => {
    vi.mocked(getTopicClusters).mockResolvedValue({
      bundles: [],
      page: 2,
      hasMore: false,
    } as never);
    const meta = await generateMetadata(req("dunya", "2"));
    expect(getTopicClusters).toHaveBeenCalledWith("dunya", 2);
    expect(meta.robots).toEqual({ index: false, follow: true });
    // The self-canonical is untouched by the robots override.
    expect(meta.alternates?.canonical).toBe("/konu/dunya?sayfa=2");
  });

  it("leaves an empty page 1 indexable (no robots override)", async () => {
    vi.mocked(getTopicClusters).mockResolvedValue({
      bundles: [],
      page: 1,
      hasMore: false,
    } as never);
    const meta = await generateMetadata(req("dunya", undefined));
    expect(meta.robots).toBeUndefined();
  });

  it("leaves a non-empty page 2 indexable (no robots override)", async () => {
    vi.mocked(getTopicClusters).mockResolvedValue({
      bundles: [{}],
      page: 2,
      hasMore: true,
    } as never);
    const meta = await generateMetadata(req("dunya", "2"));
    expect(meta.robots).toBeUndefined();
  });

  it("noindexes when the read failed (null result)", async () => {
    vi.mocked(getTopicClusters).mockResolvedValue(null);
    const meta = await generateMetadata(req("dunya", undefined));
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it("asks for the same clamped page the body uses", async () => {
    await generateMetadata(req("dunya", "999"));
    expect(getTopicClusters).toHaveBeenCalledWith("dunya", 20);
  });

  it("still returns {} for politika and an unknown slug without reading the feed", async () => {
    expect(await generateMetadata(req("politika"))).toEqual({});
    expect(await generateMetadata(req("bilinmeyen"))).toEqual({});
    expect(getTopicClusters).not.toHaveBeenCalled();
  });
});
