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
});
