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

describe("ReadAcrossSpectrum — non-voting writers on the blindspot side (browser-qa-11 / D)", () => {
  it("(a) names the non-voting writer count for a single-pole blindspot", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={true}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(markup).toContain(
      "Spektruma sayılan kaynaklar arasında bu tarafta haber yok — kör nokta (Muhalefet) · 1 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)",
    );
  });

  it("(b) omits the suffix entirely when no counts are given", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />,
    );
    expect(markup).toContain(
      "Spektruma sayılan kaynaklar arasında bu tarafta haber yok — kör nokta (Muhalefet)",
    );
    expect(markup).not.toContain("toplayıcı / niş kaynak yazdı");
  });

  it("(c) leaves the non-blindspot empty copy unchanged, with the degraded suffix when set", () => {
    const plain = renderToStaticMarkup(
      <ReadAcrossSpectrum
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(plain).toContain("Muhalefet tarafında henüz haber yok");
    expect(plain).not.toContain("toplayıcı / niş kaynak yazdı");

    const degraded = renderToStaticMarkup(
      <ReadAcrossSpectrum
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={true}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(degraded).toContain("Muhalefet tarafında henüz haber yok — bu taraftaki bazı kaynaklara şu an ulaşamıyoruz");
  });

  it("(d) sums both poles' non-voting counts when both poles are empty", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum members={[]} isBlindspot={true} nonVotingZoneCounts={{ iktidar: 2, muhalefet: 3 }} />,
    );
    expect(markup).toContain("İki kutupta da haber yok — sadece bağımsız kaynaklar yazdı · 5 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)");
  });

  it("(e) never renders 'İzlediğimiz'", () => {
    const cases = [
      renderToStaticMarkup(<ReadAcrossSpectrum members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />),
      renderToStaticMarkup(<ReadAcrossSpectrum members={[]} isBlindspot={true} />),
      renderToStaticMarkup(<ReadAcrossSpectrum members={ZERO_MUHALEFET_MEMBERS} isBlindspot={false} />),
    ];
    for (const markup of cases) {
      expect(markup).not.toContain("İzlediğimiz");
    }
  });
});
