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
  summaryLabel: "Özet — Test Kaynak",
  articleCount: 7,
  biasDistribution: dist({ pro_government: 3, opposition: 4 }),
};

const BLINDSPOT: DigestBlindspotItem = {
  id: "b1",
  title: "Tek taraflı haberleşen olay",
  summary: "Sadece bir cephe bu haberi verdi.",
  summaryLabel: "Özet — Test Kaynak",
  biasDistribution: dist({ pro_government: 9, opposition: 1 }),
  dominantZone: "iktidar",
  dominantPct: 0.9,
  nonVotingOutside: 0,
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

  it("renders 'Sadece <zone> yazdı' when the other two zones have no sources", () => {
    const html = buildDigestHtml({
      ...BASE,
      blindspot: { ...BLINDSPOT, biasDistribution: dist({ pro_government: 5 }), dominantPct: 1 },
    });
    expect(html).toContain("Sadece İktidar yazdı");
  });

  it("prints %84 (largest remainder, as the zone bar's 84/8/8) for an 11/1/1 split, never Math.round's %85", () => {
    // 11/13 = 84.6. dominantPct is deliberately the rounding-prone share: the
    // copy must come from the distribution's zone counts, not from this field.
    const html = buildDigestHtml({
      ...BASE,
      blindspot: {
        ...BLINDSPOT,
        biasDistribution: dist({ pro_government: 11, center: 1, opposition: 1 }),
        dominantPct: 11 / 13,
      },
    });
    expect(html).toContain("%84 İktidar");
    expect(html).not.toContain("%85");
    expect(html).not.toContain("Sadece İktidar yazdı");
    expect(html).toContain('width="84%"');
  });

  it("does not claim 'Sadece' at 250/1/0 although the share rounds to 100", () => {
    const html = buildDigestHtml({
      ...BASE,
      blindspot: {
        ...BLINDSPOT,
        biasDistribution: dist({ pro_government: 250, center: 1 }),
        dominantPct: 250 / 251,
      },
    });
    expect(html).toContain("%100 İktidar");
    expect(html).not.toContain("Sadece İktidar yazdı");
  });

  it("ignores a stale dominantPct field: the percent is the zone's share of the distribution", () => {
    const html = buildDigestHtml({
      ...BASE,
      blindspot: { ...BLINDSPOT, dominantPct: 0.5 },
    });
    expect(html).toContain("%90 İktidar");
  });

  // h57-outbound-1: "Sadece <zone> yazdı" is decided on the voting tally, so it
  // printed over a story a toplayıcı / niş source from another zone also carried.
  describe("blindspot line with non-voting sources from another zone (h57-outbound-1)", () => {
    const ONLY_IKTIDAR = dist({ pro_government: 5 });

    it("prints 'Spektrumda sadece <Label>' when the zone is the only voting one and an outsider carried the story", () => {
      const html = buildDigestHtml({
        ...BASE,
        blindspot: { ...BLINDSPOT, biasDistribution: ONLY_IKTIDAR, dominantPct: 1, nonVotingOutside: 2 },
      });
      expect(html).toContain("Spektrumda sadece İktidar");
      expect(html).not.toContain("Sadece İktidar yazdı");
      expect(html).not.toMatch(/sadece \S+ yazdı/i);
    });

    it("keeps 'Sadece <Label> yazdı' byte-identical when nobody outside the zone carried it", () => {
      const html = buildDigestHtml({
        ...BASE,
        blindspot: { ...BLINDSPOT, biasDistribution: ONLY_IKTIDAR, dominantPct: 1, nonVotingOutside: 0 },
      });
      expect(html).toContain("Sadece İktidar yazdı");
      expect(html).not.toContain("Spektrumda");
    });

    it("leaves the %share line alone below 'only', whatever the outsider count", () => {
      for (const nonVotingOutside of [0, 3]) {
        const html = buildDigestHtml({ ...BASE, blindspot: { ...BLINDSPOT, nonVotingOutside } });
        expect(html).toContain("%90 İktidar");
        expect(html).not.toContain("Spektrumda");
        expect(html).not.toMatch(/sadece İktidar/i);
      }
    });

    it("leaves 250/1/0 on the %share line even with an outsider", () => {
      const html = buildDigestHtml({
        ...BASE,
        blindspot: { ...BLINDSPOT, biasDistribution: dist({ pro_government: 250, center: 1 }), dominantPct: 250 / 251, nonVotingOutside: 1 },
      });
      expect(html).toContain("%100 İktidar");
      expect(html).not.toContain("Spektrumda");
    });

    it("uses the dominant zone's label for the other zones", () => {
      const html = buildDigestHtml({
        ...BASE,
        blindspot: { ...BLINDSPOT, biasDistribution: dist({ opposition: 4 }), dominantZone: "muhalefet", dominantPct: 1, nonVotingOutside: 1 },
      });
      expect(html).toContain("Spektrumda sadece Muhalefet");
    });

    it("changes only that line: the zone bar and the title are the same with and without outsiders", () => {
      const blindspot = { ...BLINDSPOT, biasDistribution: ONLY_IKTIDAR, dominantPct: 1 };
      const qualified = buildDigestHtml({ ...BASE, blindspot: { ...blindspot, nonVotingOutside: 2 } });
      const plain = buildDigestHtml({ ...BASE, blindspot: { ...blindspot, nonVotingOutside: 0 } });
      expect(qualified.replace("Spektrumda sadece İktidar", "Sadece İktidar yazdı")).toBe(plain);
    });
  });

  // h66-statsparity-1: the story line under the zone bar printed every member
  // ("16 kaynak") while the bar above it is drawn from the voting sources only.
  describe("story source count under the zone bar (h66-statsparity-1)", () => {
    it("16 members, 10 voters: '16 kaynak (10 sınıflandırılmış)'", () => {
      const html = buildDigestHtml({
        ...BASE,
        clusters: [
          { ...CLUSTER, articleCount: 16, biasDistribution: dist({ pro_government: 9, center: 1 }) },
        ],
      });

      expect(html).toContain("16 kaynak (10 sınıflandırılmış)");
    });

    it("every member voted: the bare '16 kaynak', no marker", () => {
      const html = buildDigestHtml({
        ...BASE,
        clusters: [
          { ...CLUSTER, articleCount: 16, biasDistribution: dist({ pro_government: 9, center: 4, opposition: 3 }) },
        ],
      });

      expect(html).toContain("16 kaynak");
      expect(html).not.toContain("sınıflandırılmış");
    });

    it("the default fixture (7 members, 3 + 4 voters) stays '7 kaynak'", () => {
      const html = buildDigestHtml(BASE);

      expect(html).toMatch(/>\s*7 kaynak\s*</);
      expect(html).not.toContain("sınıflandırılmış");
    });

    it("qualifies each story on its own distribution", () => {
      const html = buildDigestHtml({
        ...BASE,
        clusters: [
          { ...CLUSTER, id: "a", articleCount: 12, biasDistribution: dist({ pro_government: 8 }) },
          { ...CLUSTER, id: "b", articleCount: 5, biasDistribution: dist({ pro_government: 3, opposition: 2 }) },
        ],
      });

      expect(html).toContain("12 kaynak (8 sınıflandırılmış)");
      expect(html).toContain("5 kaynak");
      expect(html).not.toContain("5 kaynak (");
    });

    it("leaves the zone bar and the blindspot line alone", () => {
      const marked = buildDigestHtml({
        ...BASE,
        clusters: [{ ...CLUSTER, articleCount: 16 }],
      });
      const bare = buildDigestHtml({
        ...BASE,
        clusters: [{ ...CLUSTER, articleCount: 7 }],
      });

      // Same distribution, so the same bar cells; only the count line differs.
      expect(marked).toContain('width="43%"');
      expect(marked).toContain('width="57%"');
      expect(marked).toContain("%90");
      expect(marked.replace("16 kaynak (7 sınıflandırılmış)", "7 kaynak")).toBe(bare);
    });
  });

  // h87-newsletter-1: clusters.summary_tr is one outlet's words (BL-13), so the mail
  // labels it the way the cluster page does ("Özet — <Outlet>") or hides it. The
  // label text is `summaryLabel(attribution)`, computed by the route; this module
  // only places and escapes it.
  describe("summary attribution label (h87-newsletter-1)", () => {
    const cases: Array<{
      name: string;
      render: (patch: { summary?: string; summaryLabel?: string | null }) => string;
    }> = [
      {
        name: "story block",
        render: (patch) => buildDigestHtml({ ...BASE, blindspot: null, clusters: [{ ...CLUSTER, ...patch }] }),
      },
      {
        name: "blindspot block",
        render: (patch) => buildDigestHtml({ ...BASE, clusters: [], blindspot: { ...BLINDSPOT, ...patch } }),
      },
    ];

    for (const { name, render } of cases) {
      describe(name, () => {
        it("prints the label, and prints it before the excerpt", () => {
          const html = render({ summary: "Kara para aklama…", summaryLabel: "Özet — Mynet" });
          expect(html).toContain("Özet — Mynet");
          expect(html).toContain("Kara para aklama…");
          expect(html.indexOf("Özet — Mynet")).toBeLessThan(html.indexOf("Kara para aklama"));
        });

        it("HTML-escapes the label", () => {
          const html = render({ summary: "Kara para aklama…", summaryLabel: "Özet — <b>X</b>" });
          expect(html).not.toContain("<b>X</b>");
          expect(html).toContain("Özet — &lt;b&gt;X&lt;/b&gt;");
        });

        it("prints no label when the summary is empty, whatever the label says", () => {
          expect(render({ summary: "", summaryLabel: null })).not.toContain("Özet —");
          expect(render({ summary: "", summaryLabel: "Özet — Mynet" })).not.toContain("Özet —");
        });

        it("keeps the excerpt's own wording, with the label's heading style on its own line", () => {
          const html = render({ summary: "Kara para aklama…", summaryLabel: "Özet — Mynet" });
          // The label is its own <p> directly in front of the excerpt <p> (excerpt top margin 2px).
          expect(html).toMatch(
            /<p style="margin:6px 0 0;color:#52525b;font-size:12px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">\s*Özet — Mynet\s*<\/p>\s*<p style="margin:2px 0 0;color:#52525b;font-size:14px;line-height:1\.5;font-family:Arial,Helvetica,sans-serif;">\s*Kara para aklama…\s*<\/p>/,
          );
        });
      });
    }
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

  it("addresses the reader as siz in the footer", () => {
    const html = buildDigestHtml(BASE);
    expect(html).toContain("Bu e-postayı Tayf bültenine kaydolduğunuz için alıyorsunuz.");
    expect(html).not.toContain("kaydolduğun için");
    expect(html).not.toContain("alıyorsun.");
    // The unsubscribe link is a bare imperative and stays.
    expect(html).toContain("Bültenden çık");
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
