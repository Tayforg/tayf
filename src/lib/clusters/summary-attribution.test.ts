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

// ---------------------------------------------------------------------------
// Entity residue (read-time repair). clusters.summary_tr is the seed article's
// description verbatim, and 47 stored descriptions carry a double-encoded
// '&quot;' / '&#39;' / '&amp;' that ingest only decodes from now on. Every
// surface (cluster page, meta, JSON-LD, rss.xml, digest) goes through these
// functions, so they repair the residue and seed detection keeps working.
// ---------------------------------------------------------------------------
describe("entity residue repair", () => {
  const notWire = { isWireRedistribution: false };
  const RAW = "A &quot;b&quot; c";
  const CLEAN = 'A "b" c';

  it("summaryAttribution decodes the text and still finds the seed when the member holds the same raw string", () => {
    const m = member("a", T0, RAW);
    expect(summaryAttribution({ summary: RAW, members: [m], wire: notWire })).toEqual({
      text: CLEAN,
      source: m.source,
    });
  });

  it("still finds the seed when the member description is already clean and the summary has residue", () => {
    const m = member("a", T0, CLEAN);
    expect(summaryAttribution({ summary: RAW, members: [m], wire: notWire })).toEqual({
      text: CLEAN,
      source: m.source,
    });
  });

  it("still finds the seed when the summary is clean and the member description has residue", () => {
    const m = member("a", T0, RAW);
    expect(summaryAttribution({ summary: CLEAN, members: [m], wire: notWire })).toEqual({
      text: CLEAN,
      source: m.source,
    });
  });

  it("findSeedMember matches across raw and repaired forms, earliest first", () => {
    const early = member("a", "2026-09-06T09:59:20.000Z", RAW);
    const late = member("b", "2026-09-06T10:00:40.000Z", CLEAN);
    expect(findSeedMember([late, early], RAW)).toBe(early);
    expect(findSeedMember([late, early], CLEAN)).toBe(early);
  });

  it("findSeedMember skips a rights-blocked member that only matches after decoding", () => {
    const blocked = member("blocked", "2026-09-06T09:59:20.000Z", RAW);
    blocked.source.excerpt_allowed = false;
    const allowed = member("allowed", "2026-09-06T10:00:40.000Z", CLEAN);
    expect(findSeedMember([blocked, allowed], RAW)).toBe(allowed);
  });

  it("BL-13: hides the excerpt when the only match exists after decoding and that source has excerpt_allowed: false", () => {
    // Raw strings differ, so an exact-equality check would find no match and
    // publish the blocked outlet's words unattributed.
    const blockedClean = member("blocked", T0, CLEAN);
    blockedClean.source.excerpt_allowed = false;
    expect(
      summaryAttribution({ summary: RAW, members: [blockedClean], wire: notWire }),
    ).toBeNull();

    const blockedRaw = member("blocked", T0, RAW);
    blockedRaw.source.excerpt_allowed = false;
    expect(
      summaryAttribution({ summary: CLEAN, members: [blockedRaw], wire: notWire }),
    ).toBeNull();
  });

  it("a wire dispatch whose seed only matches after decoding is still hidden on a hash majority", () => {
    const seed = member("a", T0, RAW, "h1");
    const members = [seed, member("b", "2026-09-06T10:10:00Z", null, "h1")];
    expect(
      summaryAttribution({ summary: CLEAN, members, wire: { isWireRedistribution: true } }),
    ).toBeNull();
  });

  it("summaryAttributionWithoutMembers decodes", () => {
    expect(summaryAttributionWithoutMembers({ summary: ` ${RAW} `, wire: notWire })).toEqual({
      text: CLEAN,
      source: null,
    });
  });

  it("resolveSummaryAttribution decodes on both the member-aware and the degraded path", () => {
    const m = member("a", T0, RAW);
    expect(
      resolveSummaryAttribution({ summary: RAW, members: [m], lookupFailed: false, wire: notWire }),
    ).toEqual({ text: CLEAN, source: m.source });
    expect(
      resolveSummaryAttribution({
        summary: RAW,
        members: undefined,
        lookupFailed: false,
        wire: notWire,
      }),
    ).toEqual({ text: CLEAN, source: null });
  });

  it("describeForMeta output contains the quote and not the entity", () => {
    const attribution = summaryAttribution({ summary: RAW, members: [], wire: notWire });
    const meta = describeForMeta({ count: 2, attribution });
    expect(meta).toContain('"');
    expect(meta).not.toContain("&quot;");
    expect(meta).toBe(`2 kaynak. Kaynak açıklaması: ${CLEAN}`);
  });

  it("decodes apostrophes and ampersands too, and repairs a nested level", () => {
    const a = summaryAttributionWithoutMembers({
      summary: "Erdoğan&#39;dan &amp;amp; &amp;#8217;",
      wire: notWire,
    });
    expect(a?.text).toBe("Erdoğan'dan & ’");
  });

  it("never turns entity-encoded markup into markup", () => {
    const a = summaryAttributionWithoutMembers({
      summary: "&amp;lt;script&amp;gt;alert(1)&amp;#60;/script&amp;#62;",
      wire: notWire,
    });
    expect(a?.text).not.toContain("<");
    expect(a?.text).not.toContain(">");
    expect(a?.text).toBe("&lt;script&gt;alert(1)&#60;/script&#62;");
  });

  it("leaves clean text and legitimate ampersands untouched", () => {
    const a = summaryAttributionWithoutMembers({
      summary: "AT&T ve Fenerbahçe 50% & fazlası",
      wire: notWire,
    });
    expect(a?.text).toBe("AT&T ve Fenerbahçe 50% & fazlası");
  });
});

// ---------------------------------------------------------------------------
// Feed residue (read-time tidy). summary_tr is the seed's raw description, so
// it can carry glued sentences ("dedi.Y"), an outlet CTA tail ("Devamı için
// tıklayınız"), widget heading lines and raw newlines. The text that is SHOWN
// (page, meta/og/JSON-LD, rss.xml, digest) is tidied; the text that is
// COMPARED (seed match, BL-13 gate, wire majority) stays the untidied,
// entity-repaired one so those checks remain exact.
// ---------------------------------------------------------------------------
describe("feed residue tidy", () => {
  const notWire = { isWireRedistribution: false };
  const wire = { isWireRedistribution: true };
  const DIRTY = "X dedi.Y geldi. Devamı için tıklayınız";
  const TIDY = "X dedi. Y geldi.";

  it("(a) still finds the seed by the untidied text and returns tidied text attributed to it", () => {
    const m = member("a", T0, DIRTY);
    expect(findSeedMember([m], DIRTY)).toBe(m);
    expect(summaryAttribution({ summary: DIRTY, members: [m], wire: notWire })).toEqual({
      text: TIDY,
      source: m.source,
    });
  });

  it("(a) does not attribute to a member that only matches the TIDIED text", () => {
    // The member holds the clean form; the summary holds the dirty form. They
    // are different strings, so (as before this change) no member is the seed.
    const m = member("a", T0, TIDY);
    expect(findSeedMember([m], DIRTY)).toBeNull();
    expect(summaryAttribution({ summary: DIRTY, members: [m], wire: notWire })).toEqual({
      text: TIDY,
      source: null,
    });
  });

  it("(b) BL-13: still hides the excerpt when the only literal match is rights-blocked", () => {
    const blocked = member("blocked", T0, DIRTY);
    blocked.source.excerpt_allowed = false;
    expect(summaryAttribution({ summary: DIRTY, members: [blocked], wire: notWire })).toBeNull();
  });

  it("(b) BL-13: falls back to the next allowed literal match and tidies its text", () => {
    const blocked = member("blocked", "2026-09-06T09:59:20.000Z", DIRTY);
    blocked.source.excerpt_allowed = false;
    const allowed = member("allowed", "2026-09-06T10:00:40.000Z", DIRTY);
    expect(
      summaryAttribution({ summary: DIRTY, members: [blocked, allowed], wire: notWire }),
    ).toEqual({ text: TIDY, source: allowed.source });
  });

  it("(c) hides a summary that is nothing but a CTA, even with a matching allowed member", () => {
    const m = member("a", T0, "Devamı için tıklayınız");
    expect(
      summaryAttribution({ summary: "Devamı için tıklayınız", members: [m], wire: notWire }),
    ).toBeNull();
    expect(
      summaryAttribution({ summary: "  Read more ›  ", members: [], wire: notWire }),
    ).toBeNull();
  });

  it("(c) hides a summary that is nothing but a widget heading", () => {
    expect(
      summaryAttribution({ summary: "İlginizi Çekebilir", members: [], wire: notWire }),
    ).toBeNull();
  });

  it("(d) summaryAttributionWithoutMembers returns tidied text and collapses newlines", () => {
    expect(summaryAttributionWithoutMembers({ summary: DIRTY, wire: notWire })).toEqual({
      text: TIDY,
      source: null,
    });
    expect(
      summaryAttributionWithoutMembers({
        summary: "belirtti.\nİlginizi Çekebilir\nToplantıya\n\n katıldı.",
        wire: notWire,
      }),
    ).toEqual({ text: "belirtti. Toplantıya katıldı.", source: null });
  });

  it("(d) summaryAttributionWithoutMembers hides a CTA-only summary and still hides wire copies", () => {
    expect(
      summaryAttributionWithoutMembers({ summary: "Devamı için tıklayınız", wire: notWire }),
    ).toBeNull();
    expect(summaryAttributionWithoutMembers({ summary: DIRTY, wire })).toBeNull();
  });

  it("(d) resolveSummaryAttribution returns tidied text on both the member-aware and degraded paths", () => {
    const m = member("a", T0, DIRTY);
    expect(
      resolveSummaryAttribution({
        summary: DIRTY,
        members: [m],
        lookupFailed: false,
        wire: notWire,
      }),
    ).toEqual({ text: TIDY, source: m.source });
    expect(
      resolveSummaryAttribution({
        summary: DIRTY,
        members: undefined,
        lookupFailed: false,
        wire: notWire,
      }),
    ).toEqual({ text: TIDY, source: null });
    // A failed lookup still hides everything: tidy must not reopen that door.
    expect(
      resolveSummaryAttribution({
        summary: DIRTY,
        members: undefined,
        lookupFailed: true,
        wire: notWire,
      }),
    ).toBeNull();
  });

  it("(d) collapses raw newlines in the member-aware path too", () => {
    const raw = "Birinci cümle.\nİkinci cümle.\r\nÜçüncü cümle.";
    const m = member("a", T0, raw);
    expect(summaryAttribution({ summary: raw, members: [m], wire: notWire })).toEqual({
      text: "Birinci cümle. İkinci cümle. Üçüncü cümle.",
      source: m.source,
    });
  });

  it("(e) describeForMeta built from a CTA-tailed summary has no 'Devamı' and no newline", () => {
    const raw = "Yangın çıktı.Ekipler geldi.\nDevamı için tıklayınız";
    const m = member("a", T0, raw);
    const attribution = summaryAttribution({ summary: raw, members: [m], wire: notWire });
    const meta = describeForMeta({ count: 2, attribution });
    expect(meta).not.toContain("Devamı");
    expect(meta).not.toContain("\n");
    expect(meta).toBe("2 kaynak. a: Yangın çıktı. Ekipler geldi.");
  });

  it("(f) a wire dispatch whose seed only matches the UNTIDIED text is still hidden on a hash majority", () => {
    const seed = member("a", T0, DIRTY, "h1");
    const members = [seed, member("b", "2026-09-06T10:10:00Z", null, "h1")];
    expect(summaryAttribution({ summary: DIRTY, members, wire })).toBeNull();
  });

  it("(f) the same wire dispatch is shown (tidied) when the seed's hash is not the majority", () => {
    const seed = member("a", T0, DIRTY, "h1");
    const members = [
      seed,
      member("b", "2026-09-06T10:10:00Z", null, "h2"),
      member("c", "2026-09-06T10:20:00Z", null, "h2"),
    ];
    expect(summaryAttribution({ summary: DIRTY, members, wire })).toEqual({
      text: TIDY,
      source: seed.source,
    });
  });

  it("composes with entity repair: residue is decoded first, then tidied, and the seed still matches", () => {
    const raw = "O &quot;geldi&quot; dedi.Sonra gitti. Devamını oku";
    const m = member("a", T0, raw);
    expect(summaryAttribution({ summary: raw, members: [m], wire: notWire })).toEqual({
      text: 'O "geldi" dedi. Sonra gitti.',
      source: m.source,
    });
  });

  it("leaves an already-clean summary exactly as before", () => {
    const m = member("a", T0, "Temiz bir özet.");
    expect(
      summaryAttribution({ summary: "Temiz bir özet.", members: [m], wire: notWire }),
    ).toEqual({ text: "Temiz bir özet.", source: m.source });
  });
});
