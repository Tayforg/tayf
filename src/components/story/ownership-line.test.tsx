import { describe, it, expect } from "vitest";

import { OwnershipLine } from "./ownership-line";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { Source } from "@/types";

// groupByOwner only ever reads `source.slug` (see ownership.ts), so the
// member fixture only needs a real slug — the rest of the article/source
// shape is filler to satisfy the type.
function mkMember(slug: string, id = slug): ClusterDetailMember {
  const source: Source = {
    id,
    name: slug,
    slug,
    url: `https://${slug}.example`,
    rss_url: `https://${slug}.example/rss`,
    bias: "center",
    logo_url: null,
    active: true,
    trustee_since: null,
    trustee_note: null,
  };
  return {
    source,
    article: {
      id: `article-${id}`,
      title: `Article ${id}`,
      url: `https://example.com/${id}`,
      published_at: "2026-04-17T10:00:00Z",
      image_url: null,
      content_hash: null,
    },
  };
}

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
    const el = node as { props?: { children?: unknown } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

describe("OwnershipLine", () => {
  it("renders the dominant owner clause when 3-of-5 tagged sources share an owner (3/5 = 0.6 exactly)", () => {
    const members = [
      mkMember("sabah"), // turkuvaz
      mkMember("a-haber"), // turkuvaz
      mkMember("hurriyet"), // demiroren
      mkMember("untagged-1"),
      mkMember("untagged-2"),
    ];
    const el = OwnershipLine({ members });
    expect(el).not.toBeNull();
    const text = collectText(el).join("");
    expect(text).toContain(
      "Künyesi bilinen 3 kaynak · 2 sahiplik grubu — çoğu Turkuvaz Medya",
    );
    expect(el!.props.title).toBe("Turkuvaz Medya (2), Demirören Medya (1)");
  });

  it("returns null when taggedShare is below 0.6 (3 of 6 = 0.5)", () => {
    const members = [
      mkMember("sabah"),
      mkMember("a-haber"),
      mkMember("hurriyet"),
      mkMember("untagged-1"),
      mkMember("untagged-2"),
      mkMember("untagged-3"),
    ];
    expect(OwnershipLine({ members })).toBeNull();
  });

  it("returns null when taggedSourceCount is below 3 even at 100% share", () => {
    const members = [mkMember("sabah"), mkMember("a-haber")];
    expect(OwnershipLine({ members })).toBeNull();
  });

  it("omits the dominant clause when no owner group reaches 50% of tagged sources", () => {
    const members = [
      mkMember("sabah"), // turkuvaz
      mkMember("hurriyet"), // demiroren
      mkMember("bbc-turkce"), // foreign-public (category, not an owner)
      mkMember("dw-turkce"), // foreign-public
    ];
    const el = OwnershipLine({ members });
    expect(el).not.toBeNull();
    const text = collectText(el).join("");
    expect(text).toContain("Künyesi bilinen 4 kaynak · 2 sahiplik grubu");
    expect(text).not.toContain("çoğu");
  });

  it("says 'tümü' instead of 'çoğu' when the dominant group holds 100% of tagged sources", () => {
    const members = [mkMember("sabah"), mkMember("a-haber"), mkMember("takvim")];
    const el = OwnershipLine({ members });
    expect(el).not.toBeNull();
    const text = collectText(el).join("");
    expect(text).toContain("tümü Turkuvaz Medya");
    expect(text).not.toContain("çoğu Turkuvaz Medya");
  });

  it("does not count Bağımsız/foreign-category buckets as sahiplik grupları and lowercases the dominant clause", () => {
    // 5 independents: no shared owner, but all fall in the same category
    // bucket. Must not read as "1 sahiplik grubu — çoğu Bağımsız".
    const members = [
      mkMember("t24"),
      mkMember("sozcu"),
      mkMember("birgun"),
      mkMember("bbc-turkce"),
      mkMember("dw-turkce"),
    ];
    const el = OwnershipLine({ members });
    expect(el).not.toBeNull();
    const text = collectText(el).join("");
    expect(text).toContain("Künyesi bilinen 5 kaynak · 3 bağımsız");
    expect(text).not.toContain("sahiplik grubu");
    expect(text).not.toContain("çoğu Bağımsız");
    expect(text).toContain("çoğu bağımsız");
  });

  // h46-copy-2: a qualifier is a claim about concentration, so it is only made
  // when it is true. "çoğu" needs a strict majority, "yarısı" exactly half,
  // and a tie for the top (two groups of the same size) names nobody.
  describe("qualifier honesty (strict majority / exactly half / tie)", () => {
    const text = (members: ClusterDetailMember[]) => {
      const el = OwnershipLine({ members });
      expect(el).not.toBeNull();
      return collectText(el).join("");
    };

    it("(a) 3 independent of 6 tagged, the other three owners one source each: 'yarısı bağımsız', never 'çoğu'", () => {
      const members = [
        mkMember("t24"),
        mkMember("sozcu"),
        mkMember("birgun"), // independent x3
        mkMember("yeni-safak"), // albayrak
        mkMember("hurriyet"), // demiroren
        mkMember("haberturk"), // can-holding
      ];
      const el = OwnershipLine({ members });
      const out = collectText(el).join("");
      expect(out).toBe(
        "Künyesi bilinen 6 kaynak · 3 sahiplik grubu · 3 bağımsız — yarısı bağımsız",
      );
      expect(out).not.toContain("çoğu");
      expect(el!.props.title).toBe(
        "Bağımsız (3), Albayrak Grubu (1), Can Holding (TMSF kayyum, 11.09.2025) (1), Demirören Medya (1)",
      );
    });

    it("(b) 4 independent of 6 tagged: '— çoğu bağımsız' (a strict majority keeps the word)", () => {
      const out = text([
        mkMember("t24"),
        mkMember("sozcu"),
        mkMember("birgun"),
        mkMember("cumhuriyet"), // independent x4
        mkMember("hurriyet"), // demiroren
        mkMember("yeni-safak"), // albayrak
      ]);
      expect(out.endsWith("— çoğu bağımsız")).toBe(true);
      expect(out).not.toContain("yarısı");
    });

    it("(c) 3 independent and 3 Demirören: a tie, so no qualifier and no named owner", () => {
      const out = text([
        mkMember("t24"),
        mkMember("sozcu"),
        mkMember("birgun"), // independent x3
        mkMember("hurriyet"),
        mkMember("milliyet"),
        mkMember("cnn-turk"), // demiroren x3
      ]);
      expect(out).toBe("Künyesi bilinen 6 kaynak · 1 sahiplik grubu · 3 bağımsız");
      expect(out).not.toContain("—");
      expect(out).not.toContain("çoğu");
      expect(out).not.toContain("yarısı");
    });

    it("(d) Albayrak 2 and Demirören 2: a tie, so no qualifier and neither label wins on alphabetical order", () => {
      const out = text([
        mkMember("yeni-safak"),
        mkMember("star"), // albayrak x2
        mkMember("hurriyet"),
        mkMember("milliyet"), // demiroren x2
      ]);
      expect(out).toBe("Künyesi bilinen 4 kaynak · 2 sahiplik grubu");
      expect(out).not.toContain("—");
      expect(out).not.toContain("Albayrak Grubu");
    });

    it("(e) Demirören 3 of 4: '— çoğu Demirören Medya'", () => {
      const out = text([
        mkMember("hurriyet"),
        mkMember("milliyet"),
        mkMember("cnn-turk"),
        mkMember("yeni-safak"),
      ]);
      expect(out.endsWith("— çoğu Demirören Medya")).toBe(true);
    });

    it("(f) Demirören 2 of 4 with two singletons: '— yarısı Demirören Medya', never 'çoğu'", () => {
      const out = text([
        mkMember("hurriyet"),
        mkMember("milliyet"),
        mkMember("yeni-safak"),
        mkMember("haberturk"),
      ]);
      expect(out).toBe("Künyesi bilinen 4 kaynak · 3 sahiplik grubu — yarısı Demirören Medya");
      expect(out).not.toContain("çoğu");
    });

    it("(g) every tagged source in one owner group: '— tümü <label>'", () => {
      const out = text([mkMember("hurriyet"), mkMember("milliyet"), mkMember("cnn-turk")]);
      expect(out.endsWith("— tümü Demirören Medya")).toBe(true);
    });

    it("(g) every tagged source independent: '— tümü bağımsız', not 'çoğu'", () => {
      const out = text([mkMember("t24"), mkMember("sozcu"), mkMember("birgun")]);
      expect(out).toBe("Künyesi bilinen 3 kaynak · 3 bağımsız — tümü bağımsız");
      expect(out).not.toContain("çoğu");
    });

    it("a tie below 50% (2 + 2 of 6 tagged, two singletons) has no dominant group and no qualifier", () => {
      const out = text([
        mkMember("yeni-safak"),
        mkMember("star"), // albayrak x2
        mkMember("hurriyet"),
        mkMember("milliyet"), // demiroren x2
        mkMember("haberturk"), // can-holding
        mkMember("sabah"), // turkuvaz
      ]);
      expect(out).not.toContain("—");
    });

    it("a lead of one is not a tie: 3 independent, 2 Demirören of 5 -> '— çoğu bağımsız'", () => {
      const out = text([
        mkMember("t24"),
        mkMember("sozcu"),
        mkMember("birgun"),
        mkMember("hurriyet"),
        mkMember("milliyet"),
      ]);
      expect(out.endsWith("— çoğu bağımsız")).toBe(true);
    });

    it("(h) the gate is unchanged: fewer than 3 tagged sources, or under 60% tagged, renders nothing", () => {
      expect(OwnershipLine({ members: [mkMember("t24"), mkMember("sozcu")] })).toBeNull();
      expect(
        OwnershipLine({
          members: [
            mkMember("t24"),
            mkMember("sozcu"),
            mkMember("birgun"),
            mkMember("untagged-1"),
            mkMember("untagged-2"),
          ],
        }),
      ).not.toBeNull(); // 3/5 = 0.6, exactly at the gate
      expect(
        OwnershipLine({
          members: [
            mkMember("t24"),
            mkMember("sozcu"),
            mkMember("birgun"),
            mkMember("untagged-1"),
            mkMember("untagged-2"),
            mkMember("untagged-3"),
          ],
        }),
      ).toBeNull(); // 3/6 = 0.5 < 0.6
    });
  });
});
