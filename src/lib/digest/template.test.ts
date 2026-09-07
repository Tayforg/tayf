import { describe, it, expect } from "vitest";
import { buildDigestHtml, type DigestClusterItem, type DigestBlindspotItem } from "./template";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";

function dist(overrides: Partial<Record<string, number>> = {}) {
  return { ...emptyBiasDistribution(), ...overrides };
}

const CLUSTER: DigestClusterItem = {
  id: "c1",
  title: "Meclis bütçe görüşmeleri sürüyor",
  summary: "Muhalefet ve iktidar bütçe kalemlerinde anlaşamadı.",
  articleCount: 7,
  biasDistribution: dist({ pro_government: 3, opposition: 4 }),
};

const BLINDSPOT: DigestBlindspotItem = {
  id: "b1",
  title: "Tek taraflı haberleşen olay",
  summary: "Sadece bir cephe bu haberi verdi.",
  biasDistribution: dist({ pro_government: 9, opposition: 1 }),
  dominantZone: "iktidar",
  dominantPct: 0.9,
};

const BASE = {
  clusters: [CLUSTER],
  blindspot: BLINDSPOT,
  siteUrl: "https://tayfhaber.com",
  unsubscribeUrl: "https://tayfhaber.com/api/newsletter/unsubscribe?token=abc123",
};

describe("buildDigestHtml", () => {
  it("contains every cluster title and its cluster link", () => {
    const html = buildDigestHtml(BASE);
    expect(html).toContain(CLUSTER.title);
    expect(html).toContain(`https://tayfhaber.com/cluster/${CLUSTER.id}`);
  });

  it("contains the blindspot title, link, and dominant-zone share", () => {
    const html = buildDigestHtml(BASE);
    expect(html).toContain(BLINDSPOT.title);
    expect(html).toContain(`https://tayfhaber.com/cluster/${BLINDSPOT.id}`);
    expect(html).toContain("%90");
  });

  it("renders 'Sadece <zone> yazdı' when the dominant share is 100%", () => {
    const html = buildDigestHtml({ ...BASE, blindspot: { ...BLINDSPOT, dominantPct: 1 } });
    expect(html).toContain("Sadece İktidar yazdı");
  });

  it("omits the blindspot section when there is none", () => {
    const html = buildDigestHtml({ ...BASE, blindspot: null });
    expect(html).not.toContain("Kör Nokta");
  });

  it("renders a placeholder when there are no clusters", () => {
    const html = buildDigestHtml({ ...BASE, clusters: [] });
    expect(html).toContain("öne çıkan bir hikâye yok");
  });

  it("contains the unsubscribe URL in the footer", () => {
    const html = buildDigestHtml(BASE);
    expect(html).toContain(BASE.unsubscribeUrl);
  });

  it("escapes HTML in titles and summaries so a story can never inject markup", () => {
    const malicious: DigestClusterItem = {
      ...CLUSTER,
      id: "c2",
      title: "<script>alert(1)</script> & \"quoted\"",
      summary: "5 < 10 & 'tekli tırnak'",
    };
    const html = buildDigestHtml({ ...BASE, clusters: [malicious] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("5 &lt; 10 &amp; &#39;tekli tırnak&#39;");
  });

  it("renders a three-cell zone bar sized by the cluster's zone percents", () => {
    // pro_government=3 -> iktidar, opposition=4 -> muhalefet, total 7.
    // zonePercents: iktidar ~43%, muhalefet ~57%, bagimsiz 0% (omitted).
    const html = buildDigestHtml(BASE);
    expect(html).toContain('width="43%"');
    expect(html).toContain('width="57%"');
    expect(html).toContain("#ef4444"); // iktidar
    expect(html).toContain("#10b981"); // muhalefet
  });
});
