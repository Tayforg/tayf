import { createElement } from "react";
import { preload } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClusterBundle,
  PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { mobileBannerPreload } from "@/components/story/cluster-card";
import { GENERATED_IMAGE_HOSTS } from "@/lib/images/remote-image-hosts.data";

// h160-1: HomeLcpPreload is a Server Component that renders nothing. It reads
// the cached feed, picks the card the page will show first and asks React to
// preload that card's mobile banner from the prerendered shell. The data layer
// is mocked here; the order inside <head> is pinned by
// tests/guards/home-lcp-preload.test.ts.

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: (...args: unknown[]) => getPoliticsClusters(...args),
}));

import { HomeLcpPreload } from "./home-lcp-preload";

const HOST = GENERATED_IMAGE_HOSTS.find((h) => !h.includes("*"));
if (HOST === undefined) throw new Error("no exact host in the generated list");
const photo = (n: number) => `https://${HOST}/foto/${n}.jpg`;

function bundle(
  id: string,
  firstPublished: string,
  imageUrl: string | null,
  opts: { resolved?: boolean } = {},
): ClusterBundle {
  return {
    cluster: { id, first_published: firstPublished, updated_at: firstPublished },
    articles: [
      {
        id: `${id}-a`,
        title: "Haber",
        url: `https://example.com/${id}`,
        image_url: imageUrl,
        published_at: firstPublished,
        source_id: `${id}-s`,
        // An unresolved source (no name, not in `sources`) is skipped by the card.
        ...(opts.resolved === false ? {} : { source_name: "Kaynak" }),
      },
    ],
    sources: [],
  } as unknown as ClusterBundle;
}

function feed(
  bundles: ClusterBundle[],
  breakingBundles: ClusterBundle[] = [],
): PoliticsClustersResult {
  return { bundles, breakingBundles, prefilterCount: bundles.length };
}

/** Prerenders <html><head/><body><HomeLcpPreload/></body></html> and returns the document. */
async function shell(): Promise<string> {
  const tree = createElement(
    "html",
    null,
    createElement("head"),
    createElement("body", null, createElement(HomeLcpPreload as never)),
  );
  const { prelude } = await prerender(tree, { onError: () => {} });
  const reader = prelude.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** The preload tag the card's banner would get for `url`, as React writes it. */
function expectedTag(url: string): string {
  function Hint() {
    const { href, options } = mobileBannerPreload(url);
    preload(href, options);
    return null;
  }
  const html = renderToStaticMarkup(createElement(Hint));
  const from = html.indexOf('<link rel="preload" as="image"');
  return html.slice(from, html.indexOf("/>", from) + 2);
}

function imageLinkCount(html: string): number {
  return html.split('<link rel="preload" as="image"').length - 1;
}

beforeEach(() => {
  getPoliticsClusters.mockReset();
});

describe("HomeLcpPreload", () => {
  it("renders nothing and preloads card 0's banner into the shell", async () => {
    getPoliticsClusters.mockResolvedValue(
      feed([bundle("c1", "2026-11-12T09:00:00Z", photo(1))]),
    );
    expect(await HomeLcpPreload()).toBeNull();

    const html = await shell();
    expect(imageLinkCount(html)).toBe(1);
    expect(html).toContain(expectedTag(photo(1)));
    // It is a hint only: no element of its own in <body>.
    expect(html.slice(html.indexOf("<body"))).toBe("<body></body></html>");
  });

  it("reads the default feed: getPoliticsClusters is called with no argument", async () => {
    getPoliticsClusters.mockResolvedValue(feed([]));
    await HomeLcpPreload();
    expect(getPoliticsClusters).toHaveBeenCalledTimes(1);
    expect(getPoliticsClusters).toHaveBeenCalledWith();
  });

  it("picks the card the page shows first: the newest day's first story, not ranked[0] from yesterday", async () => {
    getPoliticsClusters.mockResolvedValue(
      feed([
        bundle("old", "2026-11-11T15:00:00Z", photo(1)),
        bundle("new", "2026-11-12T09:00:00Z", photo(2)),
      ]),
    );
    const html = await shell();
    expect(imageLinkCount(html)).toBe(1);
    expect(html).toContain(expectedTag(photo(2)));
    expect(html).not.toContain(expectedTag(photo(1)));
  });

  it("the Son Dakika strip comes first when it is not empty", async () => {
    getPoliticsClusters.mockResolvedValue(
      feed(
        [bundle("ranked", "2026-11-12T09:00:00Z", photo(1))],
        [bundle("brk", "2026-11-12T09:30:00Z", photo(2))],
      ),
    );
    const html = await shell();
    expect(html).toContain(expectedTag(photo(2)));
    expect(html).not.toContain(expectedTag(photo(1)));
  });

  it("uses the first usable hero image of the card, skipping an unresolved source's image", async () => {
    const card = bundle("c1", "2026-11-12T09:00:00Z", photo(1), { resolved: false });
    (card.articles as unknown as Array<Record<string, unknown>>).push({
      id: "c1-b",
      title: "Haber 2",
      url: "https://example.com/c1-b",
      image_url: photo(2),
      published_at: "2026-11-12T09:00:00Z",
      source_id: "c1-s2",
      source_name: "Kaynak 2",
    });
    getPoliticsClusters.mockResolvedValue(feed([card]));
    const html = await shell();
    expect(html).toContain(expectedTag(photo(2)));
    expect(html).not.toContain(expectedTag(photo(1)));
  });

  it("emits no preload for an empty feed", async () => {
    getPoliticsClusters.mockResolvedValue(feed([]));
    expect(imageLinkCount(await shell())).toBe(0);
  });

  it("emits no preload when the card has no usable image", async () => {
    getPoliticsClusters.mockResolvedValue(
      feed([
        bundle("c1", "2026-11-12T09:00:00Z", null),
        bundle("c2", "2026-11-12T08:00:00Z", "https://not-listed.example/a.jpg"),
      ]),
    );
    expect(imageLinkCount(await shell())).toBe(0);
  });

  it("swallows a feed failure: returns null, no preload, no rejection", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("service role key missing"));
    await expect(HomeLcpPreload()).resolves.toBeNull();
    expect(imageLinkCount(await shell())).toBe(0);
  });

  it("swallows a synchronous throw from the feed call too", async () => {
    getPoliticsClusters.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(HomeLcpPreload()).resolves.toBeNull();
  });
});
