import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// House pattern: see cluster-card-image.test.tsx. This branch only ever
// renders the plain empty-state <p> (no TrackedLink/ExternalLink), so no
// client-only mocking is needed for these two cases.
import { ReadAcrossSpectrum } from "./read-across-spectrum";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { Source } from "@/types";

// Fixture shape mirrors read-across.test.ts's mkSource/mkMember helpers.

function mkSource(id: string, bias: Source["bias"]): Source {
  return {
    id,
    name: `Source ${id}`,
    slug: `source-${id}`,
    url: `https://example.com/${id}`,
    rss_url: `https://example.com/${id}/rss`,
    bias,
    logo_url: null,
    active: true,
  } as Source;
}

function mkMember(id: string, bias: Source["bias"], publishedAt: string): ClusterDetailMember {
  return {
    source: mkSource(id, bias),
    article: {
      id: `a-${id}`,
      title: `Headline ${id}`,
      url: `https://example.com/${id}/article`,
      published_at: publishedAt,
      image_url: null,
      content_hash: null,
    },
  };
}

// Zero muhalefet coverage, two iktidar members — picks the muhalefet pole
// (fewer members) with a null article, i.e. the empty-state branch.
const ZERO_MUHALEFET_MEMBERS: ClusterDetailMember[] = [
  mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
  mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
];

describe("ReadAcrossSpectrum — feed-degraded empty state (Pack C item 8)", () => {
  it("mentions unreachable sources when not a blindspot but the feed is degraded", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={true}
      />,
    );
    expect(markup).toContain("ulaşamıyoruz");
  });

  it("does not mention unreachable sources for the same members when the feed is not degraded", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={false}
      />,
    );
    expect(markup).not.toContain("ulaşamıyoruz");
  });
});
