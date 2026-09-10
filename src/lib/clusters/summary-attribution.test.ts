import { describe, it, expect } from "vitest";
import {
  findSeedMember,
  summaryAttribution,
  summaryAttributionWithoutMembers,
  describeForMeta,
  resolveSummaryAttribution,
} from "./summary-attribution";
import type { ClusterDetailMember } from "./cluster-detail-query";
import type { Source } from "@/types";

const T0 = "2026-09-06T10:00:00.000Z";
function src(id: string): Source {
  return { id, name: id, slug: id, url: "https://x", rss_url: "https://x/r", bias: "center", logo_url: null, active: true };
}
function member(id: string, publishedAt: string, description: string | null, hash: string | null = null): ClusterDetailMember {
  return { source: src(id), article: { id, title: id, url: "https://x", published_at: publishedAt, image_url: null, content_hash: hash, description } };
}

describe("findSeedMember", () => {
  it("matches the member whose description equals the summary, earliest on ties, null otherwise", () => {
    const early = member("a", "2026-09-06T09:59:20.000Z", " Özet ");
    const late = member("b", "2026-09-06T10:00:40.000Z", "Özet");
    expect(findSeedMember([late, early], "Özet")).toBe(early);
    expect(findSeedMember([member("c", T0, "Başka metin")], "Özet")).toBeNull();
    expect(findSeedMember([member("c", T0, null)], "  ")).toBeNull();
  });

  it("BL-13: skips a matching member whose source has excerpt_allowed: false, falling back to the next matching member", () => {
    const blocked = member("blocked", "2026-09-06T09:59:20.000Z", "Özet"); // earliest, but blocked
    blocked.source.excerpt_allowed = false;
    const allowed = member("allowed", "2026-09-06T10:00:40.000Z", "Özet"); // later, but eligible
    expect(findSeedMember([blocked, allowed], "Özet")).toBe(allowed);
  });

  it("BL-13: matches normally when excerpt_allowed is absent (legacy, treated as allowed)", () => {
    const legacy = member("legacy", T0, "Özet");
    expect(findSeedMember([legacy], "Özet")).toBe(legacy);
  });
});
describe("summaryAttribution", () => {
  const notWire = { isWireRedistribution: false };
  const wire = { isWireRedistribution: true };
  it("hides blank text; attributes to the seed, or to no one when no member matches", () => {
    expect(summaryAttribution({ summary: "  ", members: [], wire: notWire })).toBeNull();
    const m = member("a", T0, "Özet");
    expect(summaryAttribution({ summary: " Özet ", members: [m], wire: notWire })).toEqual({ text: "Özet", source: m.source });
    expect(summaryAttribution({ summary: "Özet", members: [member("b", T0, "Başka")], wire: notWire })).toEqual({ text: "Özet", source: null });
  });
  it("hides a wire copy on a content_hash tie even when the seed's hash isn't first-encountered", () => {
    const seed = member("a", T0, "AA metni", "h2");
    const members = [member("b", "2026-09-06T10:10:00Z", null, "h1"), member("c", "2026-09-06T10:20:00Z", null, "h1"), seed, member("d", "2026-09-06T10:30:00Z", null, "h2")];
    expect(summaryAttribution({ summary: "AA metni", members, wire })).toBeNull();
  });
  it("shows attribution when wire but the seed's hash isn't the majority", () => {
    const seed = member("a", T0, "AA metni", "h1");
    const members = [seed, member("b", "2026-09-06T10:10:00Z", null, "h2"), member("c", "2026-09-06T10:20:00Z", null, "h2")];
    expect(summaryAttribution({ summary: "AA metni", members, wire })).toEqual({ text: "AA metni", source: seed.source });
  });
});
describe("BL-13 excerpt_allowed gate on summaryAttribution", () => {
  const notWire = { isWireRedistribution: false };

  it("hides the excerpt entirely when the only matching member's source has excerpt_allowed: false", () => {
    const blocked = member("blocked", T0, "AA metni");
    blocked.source.excerpt_allowed = false;
    expect(
      summaryAttribution({ summary: "AA metni", members: [blocked], wire: notWire }),
    ).toBeNull();
  });

  it("falls back to the next eligible matching member instead of hiding the excerpt", () => {
    const blocked = member("blocked", "2026-09-06T09:59:20.000Z", "AA metni");
    blocked.source.excerpt_allowed = false;
    const allowed = member("allowed", "2026-09-06T10:00:40.000Z", "AA metni");
    expect(
      summaryAttribution({
        summary: "AA metni",
        members: [blocked, allowed],
        wire: notWire,
      }),
    ).toEqual({ text: "AA metni", source: allowed.source });
  });

  it("shows the excerpt unaffected when excerpt_allowed is absent (legacy, treated as allowed)", () => {
    const legacy = member("legacy", T0, "AA metni");
    expect(
      summaryAttribution({ summary: "AA metni", members: [legacy], wire: notWire }),
    ).toEqual({ text: "AA metni", source: legacy.source });
  });
});

describe("describeForMeta", () => {
  it("returns just the count when there is no attribution", () => {
    expect(describeForMeta({ count: 3, attribution: null })).toBe("3 kaynak.");
  });
  it("truncates on a word boundary and pins the source/no-source prefixes", () => {
    expect(describeForMeta({ count: 2, attribution: { text: "bir iki üç dört", source: src("AA") } }, 24)).toBe("2 kaynak. AA: bir iki…");
    expect(describeForMeta({ count: 2, attribution: { text: "bir iki üç dört", source: null } }, 40)).toBe("2 kaynak. Kaynak açıklaması: bir iki…");
  });
});
describe("describeForMeta base override", () => {
  it("uses base as the leading sentence instead of '{count} kaynak.'", () => {
    expect(
      describeForMeta({
        count: 3,
        attribution: { text: "AA metni", source: src("Anadolu Ajansi") },
        base: "3 kaynaktan haberler.",
      }),
    ).toBe("3 kaynaktan haberler. Anadolu Ajansi: AA metni");
  });
  it("returns the base as-is when there is no attribution", () => {
    expect(
      describeForMeta({
        count: 1,
        attribution: null,
        base: "1 kaynaktan haberler. Tek kaynaktan 5 kopya.",
      }),
    ).toBe("1 kaynaktan haberler. Tek kaynaktan 5 kopya.");
  });
  it("falls back to the generic 'Kaynak açıklaması' label under a base override when no source matched", () => {
    expect(
      describeForMeta({
        count: 3,
        attribution: { text: "metin", source: null },
        base: "3 kaynaktan haberler.",
      }),
    ).toBe("3 kaynaktan haberler. Kaynak açıklaması: metin");
  });
  it("truncates a base-overridden description on a word boundary", () => {
    const result = describeForMeta(
      {
        count: 2,
        attribution: {
          text: "bir iki üç dört beş altı yedi sekiz dokuz on",
          source: null,
        },
        base: "2 kaynaktan haberler.",
      },
      70,
    );
    expect(result.length).toBeLessThanOrEqual(70);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("2 kaynaktan haberler. Kaynak açıklaması:")).toBe(true);
  });
});
describe("describeForMeta title fallback (seo-2 unique descriptions)", () => {
  it("falls back to a per-cluster description built from the title when there is no attribution and no base", () => {
    const result = describeForMeta({
      count: 4,
      attribution: null,
      title: "Uzun bir haber başlığı burada duruyor",
    });
    expect(result).toContain("Uzun bir haber başlığı burada duruyor");
    expect(result.length).toBeLessThanOrEqual(160);
  });

  it("gives two different titles (same count) different descriptions", () => {
    const a = describeForMeta({ count: 4, attribution: null, title: "Başlık A" });
    const b = describeForMeta({ count: 4, attribution: null, title: "Başlık B" });
    expect(a).not.toBe(b);
  });

  it("keeps the bare '{count} kaynak.' when both attribution and title are absent", () => {
    expect(describeForMeta({ count: 5, attribution: null })).toBe("5 kaynak.");
  });

  it("truncates the title fallback on a word boundary with the ellipsis, like the attribution path", () => {
    const longTitle =
      "bir iki üç dört beş altı yedi sekiz dokuz on onbir oniki onüç ondört onbeş";
    const result = describeForMeta({ count: 2, attribution: null, title: longTitle }, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith("…")).toBe(true);
  });

  it("prefers an explicit base over the title fallback — rss.xml's own prefix is unaffected", () => {
    expect(
      describeForMeta({
        count: 5,
        attribution: null,
        title: "Bir başlık",
        base: "5 kaynaktan haberler.",
      }),
    ).toBe("5 kaynaktan haberler.");
  });
});

describe("summaryAttribution with a lighter member shape", () => {
  it("accepts a member lighter than ClusterDetailMember", () => {
    expect(
      summaryAttribution({
        summary: "Özet",
        members: [
          {
            source: { name: "AA", bias: "center" },
            article: { published_at: T0, content_hash: null, description: "Özet" },
          },
        ],
        wire: { isWireRedistribution: false },
      }),
    ).toEqual({ text: "Özet", source: { name: "AA", bias: "center" } });
  });
});
describe("summaryAttributionWithoutMembers", () => {
  const notWire = { isWireRedistribution: false };
  const wire = { isWireRedistribution: true };
  it("hides blank text", () => {
    expect(summaryAttributionWithoutMembers({ summary: "  ", wire: notWire })).toBeNull();
  });
  it("hides wholesale on any wire redistribution — no members to run the majority check on", () => {
    expect(summaryAttributionWithoutMembers({ summary: "AA metni", wire })).toBeNull();
  });
  it("attributes to no one (generic label) when non-wire", () => {
    expect(summaryAttributionWithoutMembers({ summary: " Özet ", wire: notWire })).toEqual({
      text: "Özet",
      source: null,
    });
  });
  it("is strictly more conservative than summaryAttribution: hides what the member-aware path would show", () => {
    const seed = member("a", T0, "AA metni", "h1");
    const members = [
      seed,
      member("b", "2026-09-06T10:10:00Z", null, "h2"),
      member("c", "2026-09-06T10:20:00Z", null, "h2"),
    ];
    expect(summaryAttribution({ summary: "AA metni", members, wire })).toEqual({
      text: "AA metni",
      source: seed.source,
    });
    expect(summaryAttributionWithoutMembers({ summary: "AA metni", wire })).toBeNull();
  });
});

describe("resolveSummaryAttribution (BL-13 fail-closed dispatch)", () => {
  const notWire = { isWireRedistribution: false };

  it("uses the member-aware path when members are present, regardless of lookupFailed", () => {
    const seed = member("a", T0, "AA metni");
    expect(
      resolveSummaryAttribution({
        summary: "AA metni",
        members: [seed],
        lookupFailed: false,
        wire: notWire,
      }),
    ).toEqual({ text: "AA metni", source: seed.source });
  });

  it("hides the excerpt entirely when members are absent because the lookup FAILED — never falls back to the raw summary", () => {
    expect(
      resolveSummaryAttribution({
        summary: "AA metni",
        members: undefined,
        lookupFailed: true,
        wire: notWire,
      }),
    ).toBeNull();
  });

  it("hides on a failed lookup even for text that a real member would have allowed to show", () => {
    // Same text a successful, allowed-source lookup would render (see the
    // "uses the member-aware path" case above) — the only difference is
    // lookupFailed: true, and that alone must suppress the excerpt.
    expect(
      resolveSummaryAttribution({
        summary: "AA metni",
        members: undefined,
        lookupFailed: true,
        wire: notWire,
      }),
    ).toBeNull();
  });

  it("falls back to the degraded generic-label path when members are absent because the cluster genuinely has none (lookup succeeded)", () => {
    expect(
      resolveSummaryAttribution({
        summary: "AA metni",
        members: undefined,
        lookupFailed: false,
        wire: notWire,
      }),
    ).toEqual({ text: "AA metni", source: null });
  });

  it("degraded path still hides wholesale on wire redistribution when lookup succeeded with no members", () => {
    expect(
      resolveSummaryAttribution({
        summary: "AA metni",
        members: undefined,
        lookupFailed: false,
        wire: { isWireRedistribution: true },
      }),
    ).toBeNull();
  });
});
