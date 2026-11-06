import { describe, it, expect } from "vitest";
import {
  findSeedMember,
  summaryAttribution,
  summaryAttributionWithoutMembers,
  describeForMeta,
  resolveSummaryAttribution,
} from "./summary-attribution";
import type { ClusterDetailMember } from "./cluster-detail-query";
import {
  AGENCY_COPY_OVERLAP,
  AGREEMENT_HIGH,
  AGREEMENT_LOW,
  seedDisqualified,
  summaryDefect,
  textOverlap,
  titleAgreement,
} from "./summary-agreement";
import { tidySummaryText } from "@/lib/articles/summary-tidy";
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

describe("describeForMeta whitespace at the cut boundary (h22-editorial-2)", () => {
  // c2a97d0a: "... hayata geçirilecek.  Ulaştırma ..." (two spaces). The cut lands
  // on the last space of the window; with the double space that was the second
  // one, so the first stayed in front of the ellipsis: "geçirilecek. …".
  const prefix = "2 kaynak. Kaynak açıklaması: ";
  const text = "Yeni proje hayata geçirilecek.  Ulaştırma Bakanı açıkladı";

  it("never leaves a blank in front of the ellipsis", () => {
    // max - 1 characters = prefix + "Yeni proje hayata geçirilecek.  " (both spaces in the window).
    const max = prefix.length + "Yeni proje hayata geçirilecek.  ".length + 1;
    const out = describeForMeta({ count: 2, attribution: { text, source: null } }, max);
    expect(out).not.toMatch(/\s…$/);
    expect(out).toBe(`${prefix}Yeni proje hayata geçirilecek.…`);
  });

  it("holds for every cut position over a text full of double spaces", () => {
    const spaced = "bir  iki  üç   dört    beş  altı";
    for (let max = prefix.length + 2; max < prefix.length + spaced.length; max++) {
      const out = describeForMeta({ count: 2, attribution: { text: spaced, source: null } }, max);
      expect(out, `max=${max}`).not.toMatch(/\s…$/);
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
    }
  });

  it("the title fallback gets the same trim", () => {
    // 26 characters in the window: "3 kaynak, tek haber: Bir  " (both spaces).
    const out = describeForMeta({ count: 3, attribution: null, title: "Bir  iki  üç dört" }, 27);
    expect(out).not.toMatch(/\s…$/);
    expect(out).toBe("3 kaynak, tek haber: Bir…");
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

// ---------------------------------------------------------------------------
// Meta / OG / JSON-LD descriptions never end inside an open quotation
// (h29-regress-1). truncateWords cut at the last space of the window, so the
// description of 3ee2895b read `4 kaynak. Anadolu Ajansı: Yılmaz, "İsrail'in …
// baskısına…` with one straight quote and no closing one. A cut is balanced
// when it leaves no quotation open: the straight quote an even number of times,
// no more “ « ‘ than ” » ’ (the test the clamp repair of summary-tidy.ts uses).
// ---------------------------------------------------------------------------
function occurrences(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** True when `s` leaves no quotation open. Counts only, written for the assertions. */
function leavesNothingOpen(s: string): boolean {
  return (
    occurrences(s, '"') % 2 === 0 &&
    occurrences(s, "“") === occurrences(s, "”") &&
    occurrences(s, "«") === occurrences(s, "»") &&
    occurrences(s, "‘") <= occurrences(s, "’")
  );
}

/**
 * What truncateWords did before h29: cut at the last space of the window,
 * whatever it left open. h30-live-1 changed one thing about that cut on purpose
 * ("Partisi,…" is now "Partisi…"), so the oracle drops ", ; : – — -" in front of
 * the ellipsis too. Returns the cut and where the dangling-free text ends, so a
 * caller can tell a cut that ends inside the label.
 */
function legacyCut(full: string, max: number): { out: string; end: number } {
  if (full.length <= max) return { out: full, end: full.length };
  const truncated = full.slice(0, Math.max(0, max - 1));
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  let end = cut.length;
  while (end > 0 && (",;:–—-".includes(cut.charAt(end - 1)) || cut.charAt(end - 1).trim() === "")) end--;
  return { out: cut.slice(0, end) + "…", end };
}


describe("describeForMeta never ends inside an open quotation (h29-regress-1)", () => {
  const AA = src("Anadolu Ajansı");
  const LONG = "enerji güvenliği ".repeat(15);
  // clusters.summary_tr of 3ee2895b-b0ae-48f6-9d8a-3f695953cee3, verbatim.
  const YILMAZ_3EE2 =
    "Yılmaz, \"İsrail'in kışkırtmalarıyla başlayan savaşlar neticesinde, dünya enerji fiyatlarının ekonomiler üzerindeki baskısına şahitlik ediyoruz. Bu durum, enerji güvenliğinin sağlanmasında işbirliğinin önemini bir kez daha ortaya koymuştur.\" dedi.";
  // The fix_spec's synthetic: a curly apostrophe, the quotation closes after the window.
  const YILMAZ_SYNTHETIC =
    "Yılmaz, \"İsrail’in kışkırtmalarıyla başlayan savaşlar neticesinde, dünya enerji fiyatlarının ekonomiler üzerindeki baskısına şahitlik ediyoruz\" dedi. Bu durum…";

  it.each([
    ["3ee2895b, verbatim", YILMAZ_3EE2],
    ["the fix_spec's synthetic", YILMAZ_SYNTHETIC],
  ])("%s: the 'Yılmaz…' stub is not published, the description is the one without an attribution (h30-live-1)", (_label, text) => {
    const out = describeForMeta({ count: 4, attribution: { text, source: AA } });
    expect(out.length).toBeLessThanOrEqual(160);
    expect(occurrences(out, '"') % 2).toBe(0);
    expect(occurrences(out, "“")).toBe(occurrences(out, "”"));
    expect(occurrences(out, "«")).toBe(occurrences(out, "»"));
    expect(occurrences(out, "‘")).toBeLessThanOrEqual(occurrences(out, "’"));
    // h29 pinned "4 kaynak. Anadolu Ajansı: Yılmaz…" here: the speaker and nothing else.
    expect(out).toBe("4 kaynak.");
  });

  it("the generic label gets the same fallback (h29 pinned 'Kaynak açıklaması: Yılmaz…')", () => {
    const out = describeForMeta({ count: 4, attribution: { text: YILMAZ_3EE2, source: null } });
    expect(out).toBe("4 kaynak.");
  });

  it("holds for every limit: balanced, within the limit, and the text is not cut inside a quotation", () => {
    for (const source of [AA, null]) {
      for (let max = 12; max <= 330; max++) {
        const out = describeForMeta({ count: 4, attribution: { text: YILMAZ_3EE2, source } }, max);
        expect(leavesNothingOpen(out), `max=${max}: ${out}`).toBe(true);
        expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
      }
    }
  });

  describe("an opener in the first 40 characters of the text (h30-live-1: fewer than 60 characters survive the back-off)", () => {
    it.each([
      ["curly double", "“", "”"],
      ["angle", "«", "»"],
      ["curly single", "‘", "’"],
    ])("%s quotation: the speaker alone is a stub, so the description has no attribution", (_label, open, close) => {
      const text = `Bakan Yılmaz: ${open}${LONG}önemlidir${close} dedi.`;
      const out = describeForMeta({ count: 4, attribution: { text, source: AA } });
      // h29 pinned "4 kaynak. Anadolu Ajansı: Bakan Yılmaz…".
      expect(out).toBe("4 kaynak.");
      expect(leavesNothingOpen(out)).toBe(true);
    });

    it("the title sentence replaces the stub when there is a title", () => {
      const text = `Bakan Yılmaz: “${LONG}önemlidir” dedi.`;
      expect(describeForMeta({ count: 4, attribution: { text, source: AA }, title: "Enerji güvenliği için işbirliği çağrısı" })).toBe(
        "4 kaynak, tek haber: Enerji güvenliği için işbirliği çağrısı",
      );
    });

    it("a straight quotation too", () => {
      const text = `Bakan Yılmaz , : "${LONG}önemlidir" dedi.`;
      expect(describeForMeta({ count: 4, attribution: { text, source: AA } })).toBe("4 kaynak.");
    });
  });

  describe("an opener after at least 60 characters of the text: the cut ends in front of it", () => {
    // 60 characters of text in front of the quotation.
    const LEAD = "Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları söyledi".slice(0, 60);

    it("is 60 characters", () => {
      expect(LEAD).toHaveLength(60);
      expect(LEAD.endsWith("şunları")).toBe(true);
    });

    it.each([
      ["curly double, colon", "“", "”", ": "],
      ["angle, colon", "«", "»", ": "],
      ["curly single, colon", "‘", "’", ": "],
      ["curly double, comma", "“", "”", ", "],
      ["angle, comma", "«", "»", ", "],
      ["curly single, comma", "‘", "’", ", "],
      ["straight, blank", '"', '"', " "],
      ["straight, spaced comma and colon", '"', '"', " , : "],
    ])("%s: ends right before the opener, with the colon, comma and blank gone", (_label, open, close, sep) => {
      const text = `${LEAD}${sep}${open}${LONG}önemlidir${close} dedi.`;
      const out = describeForMeta({ count: 4, attribution: { text, source: AA } });
      expect(out).toBe(`4 kaynak. Anadolu Ajansı: ${LEAD}…`);
      expect(leavesNothingOpen(out)).toBe(true);
    });
  });

  describe("a sentence end in front of a late opener", () => {
    // 60 characters, full stop included.
    const SENTENCE = `${"Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları söyledi".slice(0, 59)}.`;

    it("is 60 characters", () => {
      expect(SENTENCE).toHaveLength(60);
    });

    it.each([
      ["curly double", "“", "”"],
      ["angle", "«", "»"],
      ["curly single", "‘", "’"],
      ["straight", '"', '"'],
    ])("%s quotation: the description ends at the sentence end, in the same shape as a cut after a period", (_label, open, close) => {
      const text = `${SENTENCE} Bakan ${open}${LONG}önemlidir${close} dedi.`;
      const out = describeForMeta({ count: 4, attribution: { text, source: AA } });
      expect(out).toBe(`4 kaynak. Anadolu Ajansı: ${SENTENCE}…`);
      expect(leavesNothingOpen(out)).toBe(true);
    });

    it.each([
      ["curly double", "“", "”"],
      ["straight", '"', '"'],
    ])("%s quotation: a first sentence of fewer than 60 characters is a stub too (h30-live-1)", (_label, open, close) => {
      // h29 pinned "4 kaynak. Anadolu Ajansı: İlk cümle burada bitti.…" here.
      const text = `İlk cümle burada bitti. Bakan ${open}${LONG}önemlidir${close} dedi.`;
      expect(describeForMeta({ count: 4, attribution: { text, source: AA } })).toBe("4 kaynak.");
    });
  });

  describe("the opener is the first character of the text", () => {
    const text = `“${LONG}önemlidir” dedi.`;
    const title = "Enerji güvenliği için işbirliği çağrısı";

    it("with a title: the same description as without an attribution", () => {
      const noAttribution = describeForMeta({ count: 4, attribution: null, title });
      expect(noAttribution).toBe("4 kaynak, tek haber: Enerji güvenliği için işbirliği çağrısı");
      expect(describeForMeta({ count: 4, attribution: { text, source: AA }, title })).toBe(noAttribution);
      expect(describeForMeta({ count: 4, attribution: { text, source: null }, title })).toBe(noAttribution);
    });

    it("without a title: the bare '4 kaynak.'", () => {
      expect(describeForMeta({ count: 4, attribution: null })).toBe("4 kaynak.");
      expect(describeForMeta({ count: 4, attribution: { text, source: AA } })).toBe("4 kaynak.");
      expect(describeForMeta({ count: 4, attribution: { text, source: null } })).toBe("4 kaynak.");
    });

    it.each([
      ["«", "»"],
      ["‘", "’"],
      ['"', '"'],
    ])("%s: the same, whatever the quotation mark", (open, close) => {
      const t = `${open}${LONG}önemlidir${close} dedi.`;
      expect(describeForMeta({ count: 4, attribution: { text: t, source: AA } })).toBe("4 kaynak.");
    });

    it("with a base: the base, as without an attribution", () => {
      expect(
        describeForMeta({ count: 3, attribution: { text, source: AA }, base: "3 kaynaktan haberler. Tek kaynaktan 5 kopya." }),
      ).toBe("3 kaynaktan haberler. Tek kaynaktan 5 kopya.");
    });
  });

  describe("the title fallback", () => {
    it("ends in front of an open quotation in the title", () => {
      const title = `Bakan Yılmaz: “${LONG}önemlidir”`;
      const out = describeForMeta({ count: 4, attribution: null, title });
      expect(out).toBe("4 kaynak, tek haber: Bakan Yılmaz…");
      expect(leavesNothingOpen(out)).toBe(true);
    });

    it("gives the bare '4 kaynak.' when the title opens with the quotation", () => {
      const title = `“${LONG}önemlidir”`;
      expect(describeForMeta({ count: 4, attribution: null, title })).toBe("4 kaynak.");
    });
  });

  describe("the rss.xml base path", () => {
    const base = "3 kaynaktan haberler.";

    const LEAD = "Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları söyledi".slice(0, 60);

    it("a quoted attribution comes out balanced", () => {
      const text = `${LEAD}, "${"enerji güvenliği ".repeat(40)}önemlidir" dedi.`;
      const out = describeForMeta({ count: 3, attribution: { text, source: AA }, base }, 400);
      expect(out).toBe(`3 kaynaktan haberler. Anadolu Ajansı: ${LEAD}…`);
      expect(leavesNothingOpen(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(400);
    });

    it("a stub (fewer than 60 characters in front of the quotation) gives the base alone (h30-live-1)", () => {
      const text = `Bakan Yılmaz, "${"enerji güvenliği ".repeat(40)}önemlidir" dedi.`;
      const out = describeForMeta({ count: 3, attribution: { text, source: AA }, base }, 400);
      // h29 pinned "3 kaynaktan haberler. Anadolu Ajansı: Bakan Yılmaz…".
      expect(out).toBe("3 kaynaktan haberler.");
    });

    it("keeps the wire note of the base and the sentence end in front of the opener", () => {
      const wireBase = "3 kaynaktan haberler. Tek kaynaktan 5 kopya.";
      const sentence = `${LEAD.slice(0, 59)}.`;
      const text = `${sentence} Bakan Yılmaz “${"enerji güvenliği ".repeat(40)}önemlidir” dedi.`;
      const out = describeForMeta({ count: 3, attribution: { text, source: null }, base: wireBase }, 400);
      expect(out).toBe(`3 kaynaktan haberler. Tek kaynaktan 5 kopya. Kaynak açıklaması: ${sentence}…`);
      expect(leavesNothingOpen(out)).toBe(true);
    });

    it("a stub sentence in front of the opener gives the base with its wire note (h30-live-1)", () => {
      const wireBase = "3 kaynaktan haberler. Tek kaynaktan 5 kopya.";
      const text = `Birinci cümle tamamlandı. Bakan Yılmaz “${"enerji güvenliği ".repeat(40)}önemlidir” dedi.`;
      const out = describeForMeta({ count: 3, attribution: { text, source: null }, base: wireBase }, 400);
      // h29 pinned "... Kaynak açıklaması: Birinci cümle tamamlandı.…".
      expect(out).toBe(wireBase);
    });
  });

  describe("balanced inputs are byte-identical to the old cut", () => {
    const prefix = "2 kaynak. Kaynak açıklaması: ";

    it("a text without a quotation: every limit gives the old output (h30-live-1: a cut that ends inside the label gives '2 kaynak.')", () => {
      const text = "Bekleniyor… ardından açıklama geldi. Bakan Yılmaz toplantıdan çıktı, sonra basına konuştu.";
      let insideLabel = 0;
      for (let max = prefix.length + 2; max <= prefix.length + text.length + 2; max++) {
        const out = describeForMeta({ count: 2, attribution: { text, source: null } }, max);
        const { out: legacy, end } = legacyCut(prefix + text, max);
        if (end <= prefix.length) {
          expect(out, `max=${max}`).toBe("2 kaynak.");
          insideLabel++;
        } else {
          expect(out, `max=${max}`).toBe(legacy);
        }
      }
      // The label-only cuts were reached (the smallest limits).
      expect(insideLabel).toBeGreaterThan(0);
    });

    it("a cut that ends in '…' keeps the old doubled ellipsis", () => {
      const text = "Bekleniyor… ardından açıklama geldi.";
      const max = prefix.length + "Bekleniyor… ".length + 1;
      expect(describeForMeta({ count: 2, attribution: { text, source: null } }, max)).toBe(`${prefix}Bekleniyor……`);
    });

    it("a text with closed quotations: a balanced cut gives the old output, any other cut is balanced", () => {
      const text =
        'Yılmaz "enerji güvenliği" için, “işbirliği” ve «dayanışma» ile ‘birlik’ çağrısı yaptı. Sonra "ikinci söz" dedi.';
      let balancedCuts = 0;
      let backedOff = 0;
      for (let max = prefix.length + 2; max <= prefix.length + text.length + 2; max++) {
        const out = describeForMeta({ count: 2, attribution: { text, source: null } }, max);
        const { out: legacy, end } = legacyCut(prefix + text, max);
        expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
        if (leavesNothingOpen(legacy)) {
          expect(out, `max=${max}`).toBe(end <= prefix.length ? "2 kaynak." : legacy);
          balancedCuts++;
        } else {
          expect(leavesNothingOpen(out), `max=${max}: ${out}`).toBe(true);
          backedOff++;
        }
      }
      // Both branches ran.
      expect(balancedCuts).toBeGreaterThan(10);
      expect(backedOff).toBeGreaterThan(10);
    });
  });
});

// ---------------------------------------------------------------------------
// h30-live-1: Meta descriptions are no longer "Outlet: Speaker…" stubs, do not
// read a U+2018 opener closed by an ASCII apostrophe as an open quotation, and
// do not end in ",…" / ";…". The texts are clusters.summary_tr of the live rows,
// verbatim (read-only query, 2026-11-03).
// ---------------------------------------------------------------------------

/** Oracle for "leaves nothing open" with the h30 rule: an ASCII apostrophe closes an open U+2018 unless a letter follows it. */
function leavesNothingOpenH30(s: string): boolean {
  const chars = Array.from(s);
  let straight = 0;
  let curly = 0;
  let angle = 0;
  let single = 0;
  chars.forEach((ch, i) => {
    if (ch === '"') straight++;
    else if (ch === "“") curly++;
    else if (ch === "”") curly--;
    else if (ch === "«") angle++;
    else if (ch === "»") angle--;
    else if (ch === "‘") single++;
    else if (ch === "’") single--;
    else if (ch === "'" && single > 0 && !/^\p{L}$/u.test(chars[i + 1] ?? "")) single--;
  });
  return straight % 2 === 0 && curly <= 0 && angle <= 0 && single <= 0;
}

/** True when `s` ends in one of , ; : – — - directly in front of the ellipsis. */
function endsDangling(s: string): boolean {
  return s.endsWith("…") && ",;:–—-".includes(s.charAt(s.length - 2));
}

describe("describeForMeta (h30-live-1)", () => {
  const AA = src("Anadolu Ajansı");
  const LONG = "enerji güvenliği ".repeat(15);
  // 3ee2895b-b0ae-48f6-9d8a-3f695953cee3
  const Y_3EE2 =
    "Yılmaz, \"İsrail'in kışkırtmalarıyla başlayan savaşlar neticesinde, dünya enerji fiyatlarının ekonomiler üzerindeki baskısına şahitlik ediyoruz. Bu durum, enerji güvenliğinin sağlanmasında işbirliğinin önemini bir kez daha ortaya koymuştur.\" dedi.";
  const TITLE_3EE2 = "Cumhurbaşkanı Yardımcısı Yılmaz'dan Enerji Piyasası Değerlendirmesi";
  // c5627cb9-4000-471c-9c42-0be5f29e62b3: U+2018 opener, ASCII closer.
  const C5627 =
    "MHP Genel Başkanı Devlet Bahçeli, ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı. Bahçeli, artan nüfus ve ihtiyaçlara dikkat çekerek 9 yeni il ve 78 yeni ilçe kurulması gerektiğini belirtti.";
  // e7a9b585-a7cb-4cb9-881b-cf387e5c63b8
  const E7A9 =
    "İsrail'de sandıktan koalisyon belirsizliğinin çıktığı 27 Ekim'deki genel seçimlerin ardından muhalefetteki Demokratlar Partisi, başbakanlık için Gadi Eisenkot'u destekleyeceğini açıkladı.";
  // 5db9fe11-46af-4ba2-82b0-cd49d2fc0482
  const F5DB =
    "63’üncüsü düzenlenen Uluslararası Antalya Altın Portakal Film Festivali, Cam Piramid’de gerçekleştirilen ödül töreniyle sona ererken; Ragıp Türk’ün yönettiği “Taş ve Tüy” “en iyi film” dahil 6 ödülle geceye damga vurdu, Yeşim Ustaoğlu “Artakalan” ile \"en iyi yönetmen\" ödülünü kucaklarken; Öykü Karayel, Mehmet Günsür, Mert Fırat ve Erol Babaoğlu oyunculuk dallarında ödüle layık görülen isimler oldu.";

  describe("the 3ee2895b attribution (Yılmaz, \"…long quote…\") falls back to the description without an attribution", () => {
    it("with a title: '4 kaynak, tek haber: <title>', within 160 and nothing open", () => {
      for (const source of [AA, null]) {
        const out = describeForMeta({ count: 4, attribution: { text: Y_3EE2, source }, title: TITLE_3EE2 });
        expect(out.startsWith("4 kaynak, tek haber: ")).toBe(true);
        expect(out).toBe(`4 kaynak, tek haber: ${TITLE_3EE2}`);
        expect(out.length).toBeLessThanOrEqual(160);
        expect(leavesNothingOpenH30(out)).toBe(true);
        expect(out).not.toContain("Yılmaz…");
      }
    });

    it("the same description as a cluster with no attribution at all", () => {
      const noAttribution = describeForMeta({ count: 4, attribution: null, title: TITLE_3EE2 });
      expect(describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: AA }, title: TITLE_3EE2 })).toBe(noAttribution);
    });

    it("without a title: '4 kaynak.'", () => {
      expect(describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: AA } })).toBe("4 kaynak.");
      expect(describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: null } })).toBe("4 kaynak.");
    });

    it("a blank title is no title", () => {
      expect(describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: AA }, title: "   " })).toBe("4 kaynak.");
    });

    it("a long title is cut by the usual word cut, still under 160", () => {
      const title = "Enerji güvenliği için işbirliği çağrısı yapan Cumhurbaşkanı Yardımcısı ".repeat(4).trim();
      const out = describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: AA }, title });
      expect(out.length).toBeLessThanOrEqual(160);
      expect(out.startsWith("4 kaynak, tek haber: Enerji güvenliği")).toBe(true);
      expect(out.endsWith("…")).toBe(true);
      expect(endsDangling(out)).toBe(false);
    });

    it("a base (rss.xml) is the fallback and the title is not used", () => {
      expect(
        describeForMeta({ count: 4, attribution: { text: Y_3EE2, source: AA }, title: TITLE_3EE2, base: "4 kaynaktan haberler." }),
      ).toBe("4 kaynaktan haberler.");
    });
  });

  describe("the 60-character rule: only a quote back-off that keeps fewer than 60 characters of text falls back", () => {
    // 59 and 60 characters of text in front of the quotation (the prefix is not counted).
    const BASE = "Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları söyledi";
    const LEAD60 = BASE.slice(0, 60);
    const LEAD59 = BASE.slice(0, 59);
    const prefix = "4 kaynak. Anadolu Ajansı: ";
    const quoted = (lead: string) => `${lead}, "${LONG}önemlidir" dedi.`;

    it("60 characters are kept", () => {
      expect(LEAD60).toHaveLength(60);
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD60), source: AA } })).toBe(`${prefix}${LEAD60}…`);
    });

    it("59 characters are a stub", () => {
      expect(LEAD59).toHaveLength(59);
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD59), source: AA } })).toBe("4 kaynak.");
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD59), source: AA }, title: "Başlık burada" })).toBe(
        "4 kaynak, tek haber: Başlık burada",
      );
    });

    it("the count is the text after the prefix: a longer source name does not change it", () => {
      const longName = src("Anadolu Ajansı Haber Merkezi");
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD60), source: longName } })).toBe(
        `4 kaynak. Anadolu Ajansı Haber Merkezi: ${LEAD60}…`,
      );
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD59), source: longName } })).toBe("4 kaynak.");
    });

    it("the generic label counts the same way", () => {
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD60), source: null } })).toBe(
        `4 kaynak. Kaynak açıklaması: ${LEAD60}…`,
      );
      expect(describeForMeta({ count: 4, attribution: { text: quoted(LEAD59), source: null } })).toBe("4 kaynak.");
    });

    it("a sentence-end back-off is counted like an opener back-off", () => {
      const sentence60 = `${LEAD59}.`;
      const sentence59 = `${BASE.slice(0, 58)}.`;
      expect(describeForMeta({ count: 4, attribution: { text: `${sentence60} Bakan "${LONG}önemlidir" dedi.`, source: AA } })).toBe(
        `${prefix}${sentence60}…`,
      );
      expect(describeForMeta({ count: 4, attribution: { text: `${sentence59} Bakan "${LONG}önemlidir" dedi.`, source: AA } })).toBe(
        "4 kaynak.",
      );
    });

    it("the title fallback does not apply the rule: its back-off keeps whatever is in front of the opener", () => {
      const title = `Bakan Yılmaz: “${LONG}önemlidir”`;
      expect(describeForMeta({ count: 4, attribution: null, title })).toBe("4 kaynak, tek haber: Bakan Yılmaz…");
    });
  });

  describe("a plain word cut is not subject to the rule", () => {
    it("the short cut stays: '2 kaynak. AA: bir iki…'", () => {
      expect(describeForMeta({ count: 2, attribution: { text: "bir iki üç dört", source: src("AA") } }, 24)).toBe("2 kaynak. AA: bir iki…");
    });

    it("a balanced quotation cut after a few words is still published", () => {
      const text = 'Yılmaz, "kısa" dedi ve toplantıdan çıktı, sonra basına konuştu.';
      const out = describeForMeta({ count: 4, attribution: { text, source: AA } }, 50);
      // 23 characters of text, far below 60: a plain cut is not held to the rule.
      expect(out).toBe('4 kaynak. Anadolu Ajansı: Yılmaz, "kısa" dedi ve…');
      expect(leavesNothingOpenH30(out)).toBe(true);
    });

    it("a cut that would end inside the label gives the description without an attribution", () => {
      // prefix "2 kaynak. AA: " is 14 characters; a 16-character limit leaves one character of text.
      // h29 gave "2 kaynak. AA:…" here.
      const out = describeForMeta({ count: 2, attribution: { text: "Yılmaz açıkladı", source: src("AA") } }, 16);
      expect(out).toBe("2 kaynak.");
      // ... and so does the title sentence when its own lead does not fit.
      const withTitle = describeForMeta({ count: 2, attribution: { text: "Yılmaz açıkladı", source: src("AA") }, title: "Bir başlık" }, 16);
      expect(withTitle).toBe("2 kaynak.");
    });
  });

  describe("c5627cb9: ‘100 il 1000 ilçe' is a balanced quotation", () => {
    const prefix = "24 kaynak. Akşam: ";

    it("is cut at a word boundary, not backed off to '…Devlet Bahçeli…'", () => {
      const out = describeForMeta({ count: 24, attribution: { text: C5627, source: src("Akşam") } });
      expect(out).toBe(
        "24 kaynak. Akşam: MHP Genel Başkanı Devlet Bahçeli, ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı. Bahçeli, artan nüfus ve ihtiyaçlara dikkat çekerek 9…",
      );
      expect(out).not.toContain("Bahçeli…");
      expect(out.length).toBeLessThanOrEqual(160);
      expect(leavesNothingOpenH30(out)).toBe(true);
    });

    it("every limit: a plain cut as soon as the text is cut past the quotation, never longer than the limit", () => {
      const full = prefix + C5627;
      for (let max = 40; max <= 160; max++) {
        const out = describeForMeta({ count: 24, attribution: { text: C5627, source: src("Akşam") } }, max);
        expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
        expect(leavesNothingOpenH30(out), `max=${max}: ${out}`).toBe(true);
        // A limit past the closing apostrophe (index of the closing one + a word) is a plain cut of the full text.
        const closer = full.indexOf("ilçe'") + "ilçe'".length;
        if (max > closer + 20) {
          expect(out.startsWith(`${prefix}MHP Genel Başkanı Devlet Bahçeli, ‘100 il 1000 ilçe' projesini`), `max=${max}`).toBe(true);
        }
      }
    });

    it("an apostrophe in front of a letter keeps the quotation open: '‘İsrail'in …' is still backed off", () => {
      const lead = "Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları".padEnd(60, "x").slice(0, 60);
      const text = `${lead} ‘İsrail'in ${LONG}tutumu`;
      const out = describeForMeta({ count: 4, attribution: { text, source: AA } });
      expect(out).toBe(`4 kaynak. Anadolu Ajansı: ${lead}…`);
    });
  });

  describe("no dangling punctuation in front of the ellipsis", () => {
    it("e7a9b585 ends '…Demokratlar Partisi…', not '…Partisi,…'", () => {
      const out = describeForMeta({ count: 7, attribution: { text: E7A9, source: src("Habertürk") } });
      expect(out).toBe(
        "7 kaynak. Habertürk: İsrail'de sandıktan koalisyon belirsizliğinin çıktığı 27 Ekim'deki genel seçimlerin ardından muhalefetteki Demokratlar Partisi…",
      );
    });

    it("5db9fe11 ends '…töreniyle sona ererken…', not '…ererken;…'", () => {
      const out = describeForMeta({ count: 1, attribution: { text: F5DB, source: src("Habertürk") } });
      expect(out.endsWith("töreniyle sona ererken…")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(160);
      expect(leavesNothingOpenH30(out)).toBe(true);
    });

    /** Every output of `text` over the limits that leave room for the label and a few words. */
    function outputsOver(text: string, name = "AA"): string[] {
      const label = "2 kaynak. AA: ".length;
      const outs: string[] = [];
      for (let max = label + 2; max <= label + text.length; max++) {
        outs.push(describeForMeta({ count: 2, attribution: { text, source: src(name) } }, max));
      }
      return outs;
    }

    it.each([",", ";", ":", "–", "—", "-"])("a cut after a word followed by %s drops it, glued or spaced", (mark) => {
      for (const text of [`bir iki${mark} üç dört beş altı`, `bir iki ${mark} üç dört beş altı`]) {
        const outs = outputsOver(text);
        // Before h30 some limit gave "bir iki,…" / "bir iki ,…" / "bir iki -…".
        expect(outs.filter(endsDangling), text).toEqual([]);
        expect(outs, text).toContain("2 kaynak. AA: bir iki…");
      }
    });

    it("several dangling marks and blanks go together", () => {
      const outs = outputsOver("bir iki , ; – üç dört beş");
      expect(outs.filter(endsDangling)).toEqual([]);
      expect(outs).toContain("2 kaynak. AA: bir iki…");
    });

    it("a cut after a sentence mark keeps it", () => {
      const outs = outputsOver("bir iki. üç dört beş altı yedi");
      expect(outs).toContain("2 kaynak. AA: bir iki.…");
    });

    it("the title fallback and a base get the same trim", () => {
      expect(describeForMeta({ count: 3, attribution: null, title: "Bir, iki, üç, dört" }, 27)).toBe("3 kaynak, tek haber: Bir…");
      expect(
        describeForMeta({ count: 2, attribution: { text: "bir iki, üç dört beş altı yedi sekiz", source: null }, base: "2 kaynaktan haberler." }, 52),
      ).toBe("2 kaynaktan haberler. Kaynak açıklaması: bir iki…");
    });

    const PROPERTY_TEXTS: ReadonlyArray<readonly [string, string, string | null]> = [
      ["3ee2895b", Y_3EE2, "Anadolu Ajansı"],
      ["c5627cb9", C5627, "Akşam"],
      ["e7a9b585", E7A9, "Habertürk"],
      ["5db9fe11", F5DB, "Habertürk"],
      ["every mark", "bir, iki; üç: dört – beş — altı - yedi, sekiz; dokuz: on – onbir — oniki - onüç, ondört; onbeş: onaltı – onyedi — onsekiz - ondokuz, yirmi; yirmibir: yirmiiki – yirmiüç", null],
      ["every mark, spaced", "bir , iki ; üç : dört – beş — altı - yedi , sekiz ; dokuz : on – onbir — oniki - onüç , ondört ; onbeş : onaltı", "AA"],
      ["double marks", "bir,, iki;; üç:: dört–– beş—— altı-- yedi,- ,; sekiz", "AA"],
    ];

    it.each(PROPERTY_TEXTS)("%s: no output over limits 40..160 ends in [,;:–—-] followed by '…', within the limit, nothing open", (_label, text, name) => {
      const source = name === null ? null : src(name);
      for (let max = 40; max <= 160; max++) {
        for (const title of [undefined, "Bir, iki; üç: dört – beş — altı - yedi, sekiz; dokuz: on – onbir"]) {
          for (const base of [undefined, "3 kaynaktan haberler."]) {
            const out = describeForMeta({ count: 3, attribution: { text, source }, title, base }, max);
            expect(endsDangling(out), `max=${max}: ${out}`).toBe(false);
            expect(out.length, `max=${max}`).toBeLessThanOrEqual(Math.max(max, (base ?? "3 kaynak.").length));
            expect(leavesNothingOpenH30(out), `max=${max}: ${out}`).toBe(true);
          }
        }
        const noAttribution = describeForMeta({ count: 3, attribution: null, title: text }, max);
        expect(endsDangling(noAttribution), `max=${max}: ${noAttribution}`).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h32-livebk-2: a text that fits under the limit is not cut, so truncateWords
// used to return it before the quote back-off ran, and 16f038d3's meta
// description kept `Hamaney, "Basra Körfezi …` with no closer. The back-off now
// runs on an uncut text too, with the same floor and the same 60-character rule
// as on a cut one; a closing quote is never added. The strings below are
// clusters.summary_tr / title_tr of the live row, verbatim (read-only query,
// 2026-11-04).
// ---------------------------------------------------------------------------
describe("h32-livebk-2: an uncut text with an unclosed quotation", () => {
  const HABERVAKTI = src("Habervakti");
  const PREFIX = "4 kaynak. Habervakti: ";
  // 16f038d3-05f2-4f2b-bda8-64056b175199
  const SUMMARY_16F0 =
    "İran dini lideri Hamaney, \"Basra Körfezi ve Hürmüz Boğazı'ndaki gelişmeler, ABD'nin yenilmezliği efsanesini yerle bir etti.";
  const TITLE_16F0 = "Trump'ın seçim hezimeti sonrası Hamaney'den ABD mesajı";
  // 80 characters, a full sentence, in front of a quotation that never closes.
  const SENTENCE = "Bakanlık, kentte yaşanan su kesintisinin yarın akşama kadar süreceğini açıkladı.";
  const LATE_OPENER_TEXT = `${SENTENCE} Vali, "Ekipler sahada çalışıyor`;

  /** True when `s` leaves no quotation open (the h30 oracle) and holds no stray straight quote. */
  const closed = (s: string): boolean =>
    occurrences(s, '"') % 2 === 0 &&
    occurrences(s, "“") === occurrences(s, "”") &&
    leavesNothingOpenH30(s);

  it("the stored row fits under the limit, so it is the uncut path", () => {
    expect(PREFIX.length + SUMMARY_16F0.length).toBeLessThan(160);
    expect(occurrences(SUMMARY_16F0, '"') % 2).toBe(1);
    expect(SENTENCE.length).toBe(80);
  });

  it("16f038d3: the unclosed quotation is a stub (24 characters in front of the opener), so the title sentence is the description", () => {
    const out = describeForMeta({
      count: 4,
      attribution: { source: HABERVAKTI, text: SUMMARY_16F0 },
      title: TITLE_16F0,
    });
    // Before h32-livebk-2: `4 kaynak. Habervakti: İran dini lideri Hamaney, "Basra Körfezi … etti.`
    expect(out).toBe(`4 kaynak, tek haber: ${TITLE_16F0}`);
    expect(occurrences(out, '"') % 2).toBe(0);
    expect(occurrences(out, "“")).toBe(occurrences(out, "”"));
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("16f038d3 without a title, with the generic label, and under an rss base: no attribution", () => {
    expect(describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text: SUMMARY_16F0 } })).toBe("4 kaynak.");
    expect(describeForMeta({ count: 4, attribution: { source: null, text: SUMMARY_16F0 }, title: TITLE_16F0 })).toBe(
      `4 kaynak, tek haber: ${TITLE_16F0}`,
    );
    expect(
      describeForMeta(
        { count: 4, attribution: { source: HABERVAKTI, text: SUMMARY_16F0 }, base: "4 kaynaktan haberler." },
        400,
      ),
    ).toBe("4 kaynaktan haberler.");
  });

  describe("a balanced short text is returned exactly as before", () => {
    it.each([
      ["a closed straight quotation", 'Bakan Yılmaz, "Yeni dönem başlıyor" dedi.'],
      ["a closed curly quotation", "Bakan Yılmaz, “Yeni dönem başlıyor” dedi."],
      ["a closed angle quotation", "Bakan Yılmaz, «Yeni dönem başlıyor» dedi."],
      ["suffix apostrophes (ABD'nin-style)", "ABD'nin yenilmezliği, İran'ın tutumu ve Hürmüz Boğazı'ndaki gelişmeler konuşuldu."],
      ["a curly single quotation closed by the ASCII apostrophe (c5627cb9)", "Bahçeli, ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı."],
      ["a curly apostrophe", "63’üncüsü düzenlenen festival Cam Piramid’de sona erdi."],
      ["no quotation at all", "Bakan Yılmaz yarın kentte incelemelerde bulunacak."],
    ])("%s", (_label, text) => {
      expect(describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text } })).toBe(`${PREFIX}${text}`);
      expect(describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text }, title: TITLE_16F0 })).toBe(
        `${PREFIX}${text}`,
      );
      expect(describeForMeta({ count: 4, attribution: { source: null, text } })).toBe(`4 kaynak. Kaynak açıklaması: ${text}`);
    });

    it("the balanced 16f038d3 sibling (the quotation closes) is not touched", () => {
      const text = `${SUMMARY_16F0.slice(0, -1)}" dedi.`;
      expect(occurrences(text, '"') % 2).toBe(0);
      expect(describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text }, title: TITLE_16F0 })).toBe(
        `${PREFIX}${text}`,
      );
    });
  });

  describe("an uncut text with at least 60 characters in front of a late unclosed opener is backed off like a cut one", () => {
    it("ends at the sentence end in front of the opener, in the '.…' convention", () => {
      expect(PREFIX.length + LATE_OPENER_TEXT.length).toBeLessThan(160);
      const out = describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text: LATE_OPENER_TEXT } });
      expect(out).toBe(`${PREFIX}${SENTENCE}…`);
      expect(closed(out)).toBe(true);
    });

    it.each([
      ["straight", '"'],
      ["curly double", "“"],
      ["angle", "«"],
      ["curly single", "‘"],
    ])("%s opener with no sentence end before it: ends in front of the opener, comma gone", (_label, open) => {
      const lead = "Enerji Bakanı Yılmaz bugün kentte yaptığı açıklamada şunları söyledi".slice(0, 60);
      const text = `${lead}, ${open}Ekipler sahada çalışıyor`;
      const out = describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text } });
      expect(out).toBe(`${PREFIX}${lead}…`);
      expect(closed(out)).toBe(true);
    });

    it("under an rss base too, keeping the wire note of the base", () => {
      const wireBase = "3 kaynaktan haberler. Tek kaynaktan 5 kopya.";
      const out = describeForMeta(
        { count: 3, attribution: { source: HABERVAKTI, text: LATE_OPENER_TEXT }, base: wireBase },
        400,
      );
      expect(out).toBe(`${wireBase} Habervakti: ${SENTENCE}…`);
    });

    it("never appends a closing quote", () => {
      const out = describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text: LATE_OPENER_TEXT } });
      expect(out.endsWith('"')).toBe(false);
      expect(out).not.toContain("çalışıyor");
    });

    it("an opener with fewer than 60 characters in front of it is a stub, like on a cut text (h30-live-1)", () => {
      const text = `Bakan Yılmaz, "Ekipler sahada çalışıyor`;
      expect(describeForMeta({ count: 4, attribution: { source: HABERVAKTI, text } })).toBe("4 kaynak.");
    });
  });

  describe("the title fallback goes through the same rule, with no minimum", () => {
    it("an uncut title with an unclosed quotation ends in front of the opener", () => {
      const title = 'Bakan Yılmaz: "Ekipler sahada çalışıyor';
      const out = describeForMeta({ count: 4, attribution: null, title });
      expect(out).toBe("4 kaynak, tek haber: Bakan Yılmaz…");
      expect(closed(out)).toBe(true);
    });

    it("a title that opens with the quotation gives the bare head", () => {
      expect(describeForMeta({ count: 4, attribution: null, title: '"Ekipler sahada çalışıyor' })).toBe("4 kaynak.");
    });

    it("a balanced title is returned exactly", () => {
      const title = "Bakan Yılmaz: \"Ekipler sahada\" dedi";
      expect(describeForMeta({ count: 4, attribution: null, title })).toBe(`4 kaynak, tek haber: ${title}`);
    });
  });

  describe("every limit at or above the full length, for unbalanced texts", () => {
    const UNBALANCED: ReadonlyArray<readonly [string, string]> = [
      ["16f038d3", SUMMARY_16F0],
      ["late opener after a sentence", LATE_OPENER_TEXT],
      ["opener at the start", '"Ekipler sahada çalışıyor, bakanlık açıklama yapacak.'],
      ["three straight quotes", 'Vali "Ekipler" dedi ve ekledi: "Sahadayız ve çalışmalar sürüyor, kesinti yarın akşama kadar bitecek.'],
      ["unclosed curly double", "Bakanlık açıklaması: Vali, “Ekipler sahada çalışıyor ve yarın akşam bitirecek"],
      ["unclosed angle", "Bakanlık açıklaması: Vali, «Ekipler sahada çalışıyor ve yarın akşam bitirecek"],
    ];

    it.each(UNBALANCED)("%s: never an odd number of \", never unequal “/”, within the limit, no closing quote added", (_label, text) => {
      expect(closed(text)).toBe(false);
      for (const source of [HABERVAKTI, null]) {
        const full = (source ? PREFIX : "4 kaynak. Kaynak açıklaması: ").length + text.length;
        for (let max = full; max <= full + 60; max++) {
          for (const title of [undefined, TITLE_16F0]) {
            for (const base of [undefined, "4 kaynaktan haberler."]) {
              const out = describeForMeta({ count: 4, attribution: { source, text }, title, base }, max);
              expect(occurrences(out, '"') % 2, `max=${max}: ${out}`).toBe(0);
              expect(occurrences(out, "“"), `max=${max}: ${out}`).toBe(occurrences(out, "”"));
              expect(closed(out), `max=${max}: ${out}`).toBe(true);
              expect(out.length, `max=${max}`).toBeLessThanOrEqual(Math.max(max, (base ?? "4 kaynak.").length));
              expect(out.endsWith('"'), `max=${max}: ${out}`).toBe(false);
            }
          }
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h31-reader-3 v2: the cluster page keeps the seed's description unless it
// DISAGREES with the cluster's current neutral title. `agreeWithTitle` is an
// opt-in; every other caller (rss.xml, the digest, the cards) never passes it.
// ---------------------------------------------------------------------------
describe("agreeWithTitle: the seed is replaced only when it disagrees with the title (h31-reader-3 v2)", () => {
  const notWire = { isWireRedistribution: false };
  const wireDispatch = { isWireRedistribution: true };

  /** A member of a named outlet; the hash is unique per slug unless given. */
  function outlet(
    name: string,
    slug: string,
    publishedAt: string,
    description: string | null,
    extra: { hash?: string | null; kind?: Source["kind"]; allowed?: boolean } = {},
  ): ClusterDetailMember {
    const m = member(slug, publishedAt, description, extra.hash === undefined ? `hash-${slug}` : extra.hash);
    m.source = { ...src(slug), name, slug, kind: extra.kind ?? "outlet" };
    if (extra.allowed !== undefined) m.source.excerpt_allowed = extra.allowed;
    return m;
  }

  /** `summaryAttribution` with the title opted in, the seed text being the stored summary. */
  const withTitle = (
    members: ClusterDetailMember[],
    title: string,
    summary: string,
    wire: { isWireRedistribution: boolean } = notWire,
  ) => summaryAttribution({ summary, members, wire, agreeWithTitle: title });

  // 6e19dd5a (4 Nov 2026, 26 kaynak): the neutral title says El Sayed was
  // elected, the stored summary is TRT Haber's pre-result article.
  const TITLE = "Abdul El Sayed ABD'de Senato'ya seçilen ilk Müslüman oldu";
  const SEED_TEXT =
    'ABD\'de "çekişmeli eyalet" olarak bilinen ve en kritik ara seçim bölgelerinden biri olan Michigan\'daki Senato yarışında, Demokratların Müslüman adayı Abdul ElSayed seçimi önde götürüyor.';
  const STAR_TEXT =
    'ABD\'de "çekişmeli eyalet" olarak bilinen ve en kritik ara seçim bölgelerinden biri olan Michigan\'daki Senato yarışında, Demokratların Müslüman adayı Abdul El-Sayed seçimi kazandı.';
  const DW_TEXT =
    "Ara seçimlerde Kongrenin her iki kanadında da çoğunluk Demokratlara geçti. Cumhuriyetçi Parti Teksas ve Kansas gibi eyaletleri kaybetti. Abdul El-Sayed Senato'ya seçilen ilk Müslüman siyasetçi oldu.";
  const HABER7_TEXT =
    "ABD'deki senato seçimlerinde Demokrat Parti adayı Abdul El Sayed, Michigan’daki seçimleri resmen kazanarak Senato’ya seçilen ilk Müslüman oldu.";
  const TURKIYE_TEXT =
    "ABD’deki ara seçimlerde Michigan eyaletinde, Mısır asıllı Müslüman aday Abdul el-Sayed, Cumhuriyetçi rakibi Mike Rogers’a üstünlük sağlayarak ABD Senatosuna seçilen ilk Müslüman oldu.";

  // The shapes the newest-member rule (attempt 1) chose and the replay judged
  // worse, each with a strong title agreement so that only the quality
  // predicates keep it out.
  const STUB_TEXT =
    "Michigan'da Senato seçimini kazanan Abdul El Sayed, ABD'de Senato'ya seçilen ilk Müslüman oldu ve tarihe geç...";
  const TEASER_TEXT =
    "ABD'deki senato seçimlerinde Demokrat Parti adayı Abdul El Sayed, Michigan’daki seçimleri resmen kazanarak Senato’ya seçilen ilk Müslüman oldu. Peki, Abdul El Sayed kimdir? Kaç yaşında, aslen nereli?";
  const DATELINE_TEXT =
    "İSTANBUL (Medyascope) – Abdul El Sayed, Michigan'daki Senato yarışını kazanarak ABD'de Senato'ya seçilen ilk Müslüman oldu.";
  const RUN_ON_TEXT =
    "Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu, ABD'de tarihe geçti.";

  const SEED_AT = "2026-11-04T06:28:00.000Z";
  const trt = () => outlet("TRT Haber", "trt-haber", SEED_AT, SEED_TEXT);
  const star = () => outlet("Star", "star", "2026-11-04T07:05:00.000Z", STAR_TEXT);
  const dw = () => outlet("DW Türkçe", "dw-turkce", "2026-11-04T07:25:00.000Z", DW_TEXT);
  const haber7 = () => outlet("Haber7", "haber7", "2026-11-04T07:23:00.000Z", HABER7_TEXT);
  const turkiye = () => outlet("Türkiye Gazetesi", "turkiye-gazetesi", "2026-11-04T07:49:00.000Z", TURKIYE_TEXT);

  /** The story with the seed, a mid-agreement member and two clean 1.0 members. */
  function story() {
    const seed = trt();
    const members = [turkiye(), haber7(), dw(), star(), seed];
    return { seed, members };
  }

  it("the fixture is what the cases below assume (agreement levels and the thresholds)", () => {
    expect(titleAgreement(TITLE, SEED_TEXT)).toBeCloseTo(4 / 9, 10);
    expect(titleAgreement(TITLE, STAR_TEXT)).toBeCloseTo(6 / 9, 10);
    expect(titleAgreement(TITLE, DW_TEXT)).toBeCloseTo(8 / 9, 10);
    expect(titleAgreement(TITLE, HABER7_TEXT)).toBe(1);
    expect(titleAgreement(TITLE, TURKIYE_TEXT)).toBe(1);
    expect(titleAgreement(TITLE, SEED_TEXT)!).toBeLessThan(AGREEMENT_LOW);
    for (const hazard of [STUB_TEXT, TEASER_TEXT, DATELINE_TEXT, RUN_ON_TEXT]) {
      expect(titleAgreement(TITLE, hazard)!, hazard).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(summaryDefect(hazard, hazard), hazard).not.toBeNull();
    }
  });

  it("1. 6e19dd5a shape: the seed disagrees with the title, the clean member that agrees best (newest on a tie) replaces it", () => {
    const { members } = story();
    const turkiyeMember = members[0]!;
    const out = withTitle(members, TITLE, SEED_TEXT);
    expect(out).toStrictEqual({ text: TURKIYE_TEXT, source: turkiyeMember.source });
    expect(out?.text).not.toContain("önde götürüyor");
  });

  it("1. the chosen text is the member's tidied description (a CTA tail is peeled off)", () => {
    const { members } = story();
    members[0]!.article.description = `${TURKIYE_TEXT}Devamı için tıklayınız`;
    const out = withTitle(members, TITLE, SEED_TEXT);
    expect(out?.text).toBe(TURKIYE_TEXT);
    expect(out?.source).toBe(members[0]!.source);
  });

  it("2. agreeWithTitle omitted: byte-identical to today (the seed under the seed's outlet)", () => {
    const { members, seed } = story();
    const out = summaryAttribution({ summary: SEED_TEXT, members, wire: notWire });
    expect(out).toStrictEqual({ text: SEED_TEXT, source: seed.source });
    expect(Object.keys(out ?? {})).toEqual(["text", "source"]);
    // Undefined, blank and whitespace-only titles are the same as omitted.
    for (const agreeWithTitle of [undefined, "", "   ", "\n"]) {
      expect(summaryAttribution({ summary: SEED_TEXT, members, wire: notWire, agreeWithTitle })).toStrictEqual({
        text: SEED_TEXT,
        source: seed.source,
      });
    }
  });

  it("3. the seed is kept when it agrees with the title", () => {
    const { members, seed } = story();
    const agreeing = "Michigan'daki Senato yarışında Abdul ElSayed seçimi önde götürüyor";
    expect(titleAgreement(agreeing, SEED_TEXT)).toBe(1);
    expect(withTitle(members, agreeing, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
  });

  it("3. the seed is kept when nobody agrees any better (the gate needs a member at 0.75 or more)", () => {
    const seed = trt();
    const members = [star(), seed, outlet("Sözcü", "sozcu", "2026-11-04T08:00:00.000Z", "Michigan'da Senato yarışında oy sayımı sürüyor, ilk sonuçlar Demokrat adayın lehine görünüyor.")];
    expect(withTitle(members, TITLE, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
  });

  it("4. the highest agreement wins over a newer member that agrees less", () => {
    const { members } = story();
    const newer = outlet("Yeni Şafak", "yeni-safak", "2026-11-04T12:00:00.000Z", "Michigan'da Senato yarışını kazanan Abdul El Sayed, seçilen ilk Müslüman senatör olarak tarihe geçti ve kutlandı.");
    const score = titleAgreement(TITLE, newer.article.description ?? "")!;
    expect(score).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
    expect(score).toBeLessThan(1);
    const out = withTitle([newer, ...members], TITLE, SEED_TEXT);
    expect(out?.text).toBe(TURKIYE_TEXT);
  });

  it("4. on an equal agreement the newest member wins, whatever the member order", () => {
    const { members } = story();
    expect(withTitle(members, TITLE, SEED_TEXT)?.source?.slug).toBe("turkiye-gazetesi");
    expect(withTitle([...members].reverse(), TITLE, SEED_TEXT)?.source?.slug).toBe("turkiye-gazetesi");
    // Move Haber7 after Türkiye Gazetesi: now it is the newest.
    members.find((m) => m.source.slug === "haber7")!.article.published_at = "2026-11-04T09:00:00.000Z";
    expect(withTitle(members, TITLE, SEED_TEXT)?.source?.slug).toBe("haber7");
  });

  it("4. members published at the very same instant fall back to the outlet name, ascending", () => {
    const { members } = story();
    const at = "2026-11-04T10:00:00.000Z";
    for (const m of members) if (m.source.slug === "haber7" || m.source.slug === "turkiye-gazetesi") m.article.published_at = at;
    expect(withTitle(members, TITLE, SEED_TEXT)?.source?.slug).toBe("haber7"); // "Haber7" < "Türkiye Gazetesi"
    expect(withTitle([...members].reverse(), TITLE, SEED_TEXT)?.source?.slug).toBe("haber7");
  });

  it("4. identical texts count once and are credited to the earliest publisher", () => {
    const { members } = story();
    // A later outlet copies Haber7's sentence word for word, then a newer clean text of its own.
    const copy = outlet("Habervakti", "habervakti", "2026-11-04T09:41:00.000Z", HABER7_TEXT);
    members.push(copy);
    members.splice(members.findIndex((m) => m.source.slug === "turkiye-gazetesi"), 1);
    const out = withTitle(members, TITLE, SEED_TEXT);
    expect(out?.text).toBe(HABER7_TEXT);
    expect(out?.source?.slug).toBe("haber7"); // not the copy, although the copy is newer
  });

  it("5. every quality shape of the newest-member rule is kept out, alone and all at once", () => {
    const hazards: Array<[string, string]> = [
      ["a feed-cut stub", STUB_TEXT],
      ["a teaser question", TEASER_TEXT],
      ["a dateline", DATELINE_TEXT],
      ["a glued run-on", RUN_ON_TEXT],
    ];
    for (const [label, text] of hazards) {
      const seed = trt();
      const hazard = outlet("Tuzak", "tuzak", "2026-11-04T09:00:00.000Z", text);
      // Alone, the hazard is the only strong member: the seed stays.
      expect(withTitle([hazard, seed], TITLE, SEED_TEXT), label).toStrictEqual({ text: SEED_TEXT, source: seed.source });
      // With a clean member behind it, the clean one is chosen, never the hazard.
      const clean = dw();
      const out = withTitle([hazard, clean, seed], TITLE, SEED_TEXT);
      expect(out, label).toStrictEqual({ text: DW_TEXT, source: clean.source });
    }
    // All four newer than the clean 1.0 members: the clean newest still wins.
    const { members } = story();
    hazards.forEach(([, text], i) => {
      members.push(outlet(`Tuzak ${i}`, `tuzak-${i}`, `2026-11-04T1${i}:00:00.000Z`, text));
    });
    expect(withTitle(members, TITLE, SEED_TEXT)?.source?.slug).toBe("turkiye-gazetesi");
  });

  describe("6. a member that may not stand in", () => {
    const strong = (extra: Parameters<typeof outlet>[4] = {}, name = "Aday", slug = "aday") =>
      outlet(name, slug, "2026-11-04T09:00:00.000Z", TURKIYE_TEXT, extra);

    it.each([
      ["wire kind", { kind: "wire" as const }],
      ["aggregator kind", { kind: "aggregator" as const }],
      ["a source that asked not to be excerpted", { allowed: false }],
    ])("%s is skipped", (_label, extra) => {
      const seed = trt();
      expect(withTitle([strong(extra), seed], TITLE, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
      // ... in favour of the next best member.
      const next = dw();
      expect(withTitle([strong(extra), next, seed], TITLE, SEED_TEXT)?.source).toBe(next.source);
    });

    it("niche and outlet kinds, and a source with no kind at all, are eligible", () => {
      for (const kind of ["niche", "outlet", undefined] as const) {
        const seed = trt();
        const candidate = strong({});
        if (kind === undefined) delete (candidate.source as { kind?: unknown }).kind;
        else candidate.source.kind = kind;
        expect(withTitle([candidate, seed], TITLE, SEED_TEXT)?.source).toBe(candidate.source);
      }
    });

    it("a member that repeats the seed's text, raw or once tidied, scores what the seed scores and is never chosen", () => {
      const withCta = `${SEED_TEXT}Devamı için tıklayınız`;
      const seed = outlet("TRT Haber", "trt-haber", SEED_AT, withCta);
      const rawCopy = outlet("A", "a", "2026-11-04T09:00:00.000Z", withCta);
      const tidiedCopy = outlet("B", "b", "2026-11-04T09:10:00.000Z", SEED_TEXT);
      expect(withTitle([rawCopy, tidiedCopy, seed], TITLE, withCta)).toStrictEqual({
        text: SEED_TEXT,
        source: seed.source,
      });
    });

    it("a member whose tidied text is shorter than 60 characters is skipped (59 is short, 60 is enough)", () => {
      const seed = trt();
      const body59 = "Abdul El Sayed Michigan'da Senato'ya seçilen ilk Müslüman o".slice(0, 59);
      expect(body59.length).toBe(59);
      const short = outlet("Kısa", "kisa", "2026-11-04T09:00:00.000Z", body59);
      expect(titleAgreement(TITLE, body59)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(withTitle([short, seed], TITLE, SEED_TEXT)?.source).toBe(seed.source);
      const exact = outlet("Tam", "tam", "2026-11-04T09:00:00.000Z", `${body59}.`);
      expect(withTitle([exact, seed], TITLE, SEED_TEXT)?.source).toBe(exact.source);
      const tooShort = outlet("Kısa", "kisa", "2026-11-04T09:00:00.000Z", "Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu.");
      expect(withTitle([tooShort, seed], TITLE, SEED_TEXT)?.source).toBe(seed.source);
    });

    it("a member with a blank, missing or CTA-only description is skipped", () => {
      const seed = trt();
      for (const description of [null, "", "   ", "Devamı için tıklayınız"]) {
        const empty = outlet("Boş", "bos", "2026-11-04T09:00:00.000Z", description);
        expect(withTitle([empty, seed], TITLE, SEED_TEXT)?.source).toBe(seed.source);
      }
    });

    it("a member whose text copies a wire or aggregator member's text is skipped: the words are the agency's", () => {
      for (const kind of ["wire", "aggregator"] as const) {
        const seed = trt();
        const agency = outlet("Ajans", "ajans", "2026-11-04T08:00:00.000Z", TURKIYE_TEXT, { kind });
        const copier = outlet("Kopyacı", "kopyaci", "2026-11-04T09:00:00.000Z", `  ${TURKIYE_TEXT} `);
        expect(withTitle([copier, agency, seed], TITLE, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
      }
    });

    it("a member whose text copies a rights-blocked member's text is skipped (BL-13)", () => {
      const seed = trt();
      const blocked = outlet("Engelli", "engelli", "2026-11-04T08:00:00.000Z", TURKIYE_TEXT, { allowed: false });
      const copier = outlet("Kopyacı", "kopyaci", "2026-11-04T09:00:00.000Z", ` ${TURKIYE_TEXT}`);
      expect(withTitle([copier, blocked, seed], TITLE, SEED_TEXT)?.source).toBe(seed.source);
    });

    it("wire redistribution: a member holding the majority content hash is skipped, others are not", () => {
      const seed = outlet("TRT Haber", "trt-haber", SEED_AT, SEED_TEXT, { hash: "own" });
      const dispatchA = outlet("A", "a", "2026-11-04T09:00:00.000Z", TURKIYE_TEXT, { hash: "dispatch" });
      const dispatchB = outlet("B", "b", "2026-11-04T09:10:00.000Z", null, { hash: "dispatch" });
      const dispatchC = outlet("C", "c", "2026-11-04T09:20:00.000Z", null, { hash: "dispatch" });
      const others = [dispatchA, dispatchB, dispatchC, seed];
      expect(withTitle(others, TITLE, SEED_TEXT, wireDispatch)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
      // Without a wire redistribution the same member is an ordinary outlet.
      expect(withTitle(others, TITLE, SEED_TEXT, notWire)?.source).toBe(dispatchA.source);
    });

    it("a member in another language than the seed's is skipped, an outlet in the seed's language is not", () => {
      const names = "Abdul El Sayed Michigan Rogers Senate";
      const seedText = "Local officials in Michigan said that counting would continue on Wednesday morning.";
      expect(titleAgreement(names, seedText)!).toBeLessThan(AGREEMENT_LOW);
      const english = "Abdul El Sayed won the Michigan race against Rogers and will be sworn in as a senator next year.";
      expect(titleAgreement(names, english)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      const turkish = "Michigan'da Rogers'ı geride bırakan Abdul El Sayed, Senate koltuğunu kazanan ilk Müslüman oldu ve kutlandı.";
      // A Turkish seed (TRT Haber) never gets an English outlet's text ...
      const trtSeed = outlet("TRT Haber", "trt-haber", SEED_AT, seedText);
      const daily = outlet("Daily Sabah", "daily-sabah", "2026-11-04T09:00:00.000Z", english);
      expect(withTitle([daily, trtSeed], names, seedText)?.source).toBe(trtSeed.source);
      // ... and an English seed (TRT World) never gets a Turkish outlet's.
      const worldSeed = outlet("TRT World", "trt-world", SEED_AT, seedText);
      const sozcu = outlet("Sözcü", "sozcu", "2026-11-04T09:00:00.000Z", turkish);
      expect(titleAgreement(names, turkish)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(withTitle([sozcu, worldSeed], names, seedText)?.source).toBe(worldSeed.source);
      // English for English is fine.
      expect(withTitle([daily, worldSeed], names, seedText)?.source).toBe(daily.source);
    });
  });

  // Review fix (MEDIUM): the exact-string copy test let three of the five replay
  // swaps through (Haber7, Sabah and Aydınlık each re-ran Anadolu Ajansı's lead
  // with a phrase dropped or one word changed), and the neutral title echoes the
  // wire lead, so the agreement score favours exactly those texts. A candidate
  // that carries 85% or more of an agency's content stems, and the other way
  // round, is that agency's copy. A longer article that merely contains the lead
  // is not.
  describe("6b. a near-verbatim copy of a wire or aggregator member's text is the agency's too", () => {
    const AGENCY_AT = "2026-11-04T08:00:00.000Z";
    const LATE = "2026-11-04T09:00:00.000Z";
    // TURKIYE_TEXT with "Mısır asıllı" dropped: 20 of its 22 stems, 20 of its own 20.
    const NEAR_COPY =
      "ABD’deki ara seçimlerde Michigan eyaletinde, Müslüman aday Abdul el-Sayed, Cumhuriyetçi rakibi Mike Rogers’a üstünlük sağlayarak ABD Senatosuna seçilen ilk Müslüman oldu.";

    it("the fixture is what the cases below assume", () => {
      expect(textOverlap(TURKIYE_TEXT, NEAR_COPY)).toBeGreaterThanOrEqual(AGENCY_COPY_OVERLAP);
      expect(textOverlap(TURKIYE_TEXT, NEAR_COPY)).toBeLessThan(1);
      expect(titleAgreement(TITLE, NEAR_COPY)).toBe(1);
      // An independent rewrite of the same event is far below the threshold.
      expect(textOverlap(TURKIYE_TEXT, HABER7_TEXT)).toBeLessThan(0.6);
    });

    it.each(["wire", "aggregator"] as const)(
      "a near copy of a %s member's text is skipped for the next best member (the exact-copy test alone let it through)",
      (kind) => {
        const seed = trt();
        const agency = outlet("Ajans", "ajans", AGENCY_AT, TURKIYE_TEXT, { kind });
        const copier = outlet("Kopyacı", "kopyaci", LATE, NEAR_COPY);
        const next = dw();
        expect(withTitle([copier, agency, next, seed], TITLE, SEED_TEXT)?.source).toBe(next.source);
        expect(withTitle([copier, agency, seed], TITLE, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
        // Control: with no agency in the cluster the very same member is the pick.
        expect(withTitle([copier, next, seed], TITLE, SEED_TEXT)?.source).toBe(copier.source);
      },
    );

    it("a near copy with a CTA tail is compared on its tidied text, and so is the agency's", () => {
      const seed = trt();
      const agency = outlet("Ajans", "ajans", AGENCY_AT, `${TURKIYE_TEXT} Devamı için tıklayınız`, { kind: "wire" });
      const copier = outlet("Kopyacı", "kopyaci", LATE, `${NEAR_COPY} Haberin devamı için tıklayınız`);
      expect(withTitle([copier, agency, seed], TITLE, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
    });

    it("an independent rewrite of the same event is not a copy: it may stand in", () => {
      const seed = trt();
      const agency = outlet("Ajans", "ajans", AGENCY_AT, TURKIYE_TEXT, { kind: "wire" });
      const rewrite = haber7();
      expect(withTitle([rewrite, agency, seed], TITLE, SEED_TEXT)?.source).toBe(rewrite.source);
    });

    it("a near copy of an ordinary outlet's text is no agency copy: only wire and aggregator members count", () => {
      const seed = trt();
      const original = outlet("Özgün", "ozgun", AGENCY_AT, TURKIYE_TEXT);
      const copier = outlet("Kopyacı", "kopyaci", LATE, NEAR_COPY);
      expect(withTitle([copier, original, seed], TITLE, SEED_TEXT)?.source).toBe(copier.source);
    });

    describe("the threshold (an 8-token title and 20-stem texts: 8 title words + 12 more)", () => {
      const WORDS = ["kedi", "köpek", "kuş", "balık", "aslan", "kaplan", "zürafa", "horoz"];
      const TITLE8 = WORDS.join(" ");
      const tokens = (prefix: string, from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, "0")}`);
      const text = (...parts: string[][]) => `${[...WORDS, ...parts.flat()].join(" ")}.`;
      const SEED_OFF = "hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi (seed).";

      const run = (agencyText: string, candidateText: string, kind: "wire" | "aggregator" = "wire") => {
        const seed = outlet("Tohum", "tohum", SEED_AT, SEED_OFF);
        const agency = outlet("Ajans", "ajans", AGENCY_AT, agencyText, { kind });
        const candidate = outlet("Aday", "aday", LATE, candidateText);
        return { seed, candidate, out: withTitle([candidate, agency, seed], TITLE8, SEED_OFF) };
      };

      const AGENCY = text(tokens("p", 1, 12));

      it("the fixture scores what it says", () => {
        expect(titleAgreement(TITLE8, AGENCY)).toBe(1);
        expect(textOverlap(AGENCY, text(tokens("p", 1, 9), tokens("q", 1, 3)))).toBeCloseTo(17 / 20, 10);
        expect(textOverlap(AGENCY, text(tokens("p", 1, 8), tokens("q", 1, 4)))).toBeCloseTo(16 / 20, 10);
      });

      it("17 of 20 stems shared (exactly 0.85) is a copy, inclusive", () => {
        const r = run(AGENCY, text(tokens("p", 1, 9), tokens("q", 1, 3)));
        expect(r.out?.source).toBe(r.seed.source);
      });

      it("16 of 20 stems shared (0.80) is not a copy", () => {
        const r = run(AGENCY, text(tokens("p", 1, 8), tokens("q", 1, 4)));
        expect(r.out?.source).toBe(r.candidate.source);
      });

      it("a longer article that holds the whole agency lead (20 of 40) is not a copy, the other way round neither", () => {
        const longer = run(AGENCY, text(tokens("p", 1, 12), tokens("q", 1, 20)));
        expect(longer.out?.source).toBe(longer.candidate.source);
        const shorter = run(text(tokens("p", 1, 12), tokens("q", 1, 20)), AGENCY);
        expect(shorter.out?.source).toBe(shorter.candidate.source);
      });
    });

    it("is bounded: 300 qualifying members against 300 agency members stay well under two seconds", () => {
      const WORDS = ["kedi", "köpek", "kuş", "balık", "aslan", "kaplan", "zürafa", "horoz"];
      const own = (tag: string, i: number) =>
        `${WORDS.join(" ")} ${Array.from({ length: 12 }, (_, j) => `${tag}${String(i).padStart(3, "0")}${String.fromCharCode(97 + j)}`).join(" ")}.`;
      const off = "hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi (seed).";
      const seed = outlet("Tohum", "tohum", SEED_AT, off);
      const members = [seed];
      for (let i = 0; i < 300; i++) {
        members.push(outlet(`Ajans ${i}`, `ajans-${i}`, AGENCY_AT, own("a", i), { kind: i % 2 === 0 ? "wire" : "aggregator" }));
        members.push(outlet(`Aday ${i}`, `aday-${i}`, `2026-11-04T10:${String(i % 60).padStart(2, "0")}:00.000Z`, own("c", i)));
      }
      const start = Date.now();
      const out = withTitle(members, WORDS.join(" "), off);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out?.source?.slug).toMatch(/^aday-/);
    });
  });

  describe("7. thresholds' edges (an 8-token title: kedi köpek kuş balık aslan kaplan zürafa horoz)", () => {
    const WORDS = ["kedi", "köpek", "kuş", "balık", "aslan", "kaplan", "zürafa", "horoz"];
    const TITLE8 = WORDS.join(" ");
    /** A sentence that carries the first `hits` title words and nothing else of the title. */
    const sentence = (hits: number, salt = "") =>
      `${WORDS.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi${salt}.`;

    const run = (seedHits: number, candidateHits: number) => {
      const seed = outlet("Tohum", "tohum", SEED_AT, sentence(seedHits, " (seed)"));
      const candidate = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", sentence(candidateHits));
      return {
        seed,
        candidate,
        out: withTitle([candidate, seed], TITLE8, seed.article.description ?? ""),
      };
    };

    it("the fixture scores what it says", () => {
      for (let hits = 0; hits <= 8; hits++) {
        expect(titleAgreement(TITLE8, sentence(hits))).toBe(hits / 8);
      }
    });

    it("a seed at exactly 0.5 (4/8) is kept, one token fewer (3/8) is replaced", () => {
      const kept = run(4, 8);
      expect(kept.out?.source).toBe(kept.seed.source);
      const replaced = run(3, 8);
      expect(replaced.out?.source).toBe(replaced.candidate.source);
    });

    it("a candidate at exactly 0.75 (6/8) is enough, one token fewer (5/8) is not", () => {
      const enough = run(1, 6);
      expect(enough.out?.source).toBe(enough.candidate.source);
      const notEnough = run(1, 5);
      expect(notEnough.out?.source).toBe(notEnough.seed.source);
    });

    it("a seed that scores 0 is replaced by a 6/8 candidate; a perfect seed is never replaced", () => {
      const zero = run(0, 6);
      expect(zero.out?.source).toBe(zero.candidate.source);
      const perfect = run(8, 8);
      expect(perfect.out?.source).toBe(perfect.seed.source);
    });

    it("the gain of 0.3 is inclusive (17-token title: 8/17 -> 14/17 switches, 8/17 -> 13/17 does not)", () => {
      const words = ["abaka", "bobin", "cidem", "dalka", "ekmek", "fidan", "gazoz", "havuz", "irmak", "jeton", "kapak", "lamba", "masal", "nehir", "orman", "pamuk", "rakip"];
      const title17 = words.join(" ");
      const make = (hits: number, salt: string) =>
        `${words.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi${salt}.`;
      const seed = outlet("Tohum", "tohum", SEED_AT, make(8, " (seed)"));
      expect(titleAgreement(title17, make(8, ""))).toBeCloseTo(8 / 17, 10);
      const strong = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", make(14, ""));
      const weak = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", make(13, ""));
      expect(withTitle([strong, seed], title17, seed.article.description ?? "")?.source).toBe(strong.source);
      expect(withTitle([weak, seed], title17, seed.article.description ?? "")?.source).toBe(seed.source);
    });
  });

  describe("8. no signal means no change", () => {
    it("a title with fewer than 3 content tokens never replaces the seed", () => {
      const { members, seed } = story();
      for (const title of ["Seçim sonucu", "ve ile bir", "Michigan"]) {
        expect(withTitle(members, title, SEED_TEXT)).toStrictEqual({ text: SEED_TEXT, source: seed.source });
      }
    });

    it("a summary that is no member's description ('Kaynak açıklaması') stays as stored, with no outlet", () => {
      const { members } = story();
      const stored = "Başka bir metin, hiçbir üyenin açıklaması olmayan, saklanmış bir özet metni.";
      const out = withTitle(members, TITLE, stored);
      expect(out).toStrictEqual({ text: stored, source: null });
    });

    it("the gates in front of the choice are untouched: blank, rights-blocked everywhere, wire majority, tidied-empty", () => {
      const { members } = story();
      expect(withTitle(members, TITLE, "   ")).toBeNull();

      const blocked = story();
      blocked.seed.source.excerpt_allowed = false;
      expect(withTitle(blocked.members, TITLE, SEED_TEXT)).toBeNull();

      const wireStory = story();
      wireStory.seed.article.content_hash = "dispatch";
      wireStory.members[1]!.article.content_hash = "dispatch";
      wireStory.members[2]!.article.content_hash = "dispatch";
      expect(withTitle(wireStory.members, TITLE, SEED_TEXT, wireDispatch)).toBeNull();
      // Not a wire redistribution: the same cluster is fine.
      expect(withTitle(wireStory.members, TITLE, SEED_TEXT, notWire)?.source?.slug).toBe("turkiye-gazetesi");

      const cta = outlet("TRT Haber", "trt-haber", SEED_AT, "Devamı için tıklayınız");
      expect(withTitle([cta, ...members.slice(0, 2)], TITLE, "Devamı için tıklayınız")).toBeNull();
    });

    it("a rights-blocked seed hands the attribution to the next matching member, then compares", () => {
      const blocked = outlet("Engelli", "engelli", SEED_AT, SEED_TEXT, { allowed: false });
      const open = outlet("TRT Haber", "trt-haber", "2026-11-04T06:30:00.000Z", SEED_TEXT);
      const candidate = turkiye();
      expect(withTitle([candidate, open, blocked], TITLE, SEED_TEXT)?.source).toBe(candidate.source);
      const agree = withTitle([candidate, open, blocked], "Michigan'daki Senato yarışında Abdul ElSayed seçimi önde götürüyor", SEED_TEXT);
      expect(agree).toStrictEqual({ text: SEED_TEXT, source: open.source });
    });

    it("does not mutate its inputs", () => {
      const { members } = story();
      const before = JSON.stringify(members);
      withTitle(members, TITLE, SEED_TEXT);
      expect(JSON.stringify(members)).toBe(before);
    });
  });

  // What keeps each of attempt 1's eight worse picks out, and where that stops.
  //   - On a healthy cluster (the seed covers at least half of the headline's
  //     words) ALL eight are kept out by one thing: the seed-agrees gate. The
  //     first test below pins that.
  //   - Behind a seed that DISAGREES with the headline the gate is open and only
  //     the candidate's own text counts. Five shapes are still kept out
  //     lexically: the feed-cut stub (0.30), the teaser (0.71), the dateline lead
  //     (0.63), the generic round-up (0.42) and the dropped fact (0.44) cover
  //     less than 0.75 of the headline's words, and the glued run-on covers all
  //     of them but summaryDefect flags it.
  //   - Two shapes are NOT kept out lexically: the loaded framing (0.875) and the
  //     contradiction (1.0) use the headline's own words and are clean text. Tone
  //     and meaning are not visible to a token overlap. Behind a disagreeing seed
  //     they win when they are the best-agreeing member; the second block below
  //     pins that so that a future change to the rule is a conscious decision.
  describe("9. the eight shapes the newest-member rule (attempt 1) got wrong", () => {
    interface Shape {
      id: string;
      shape: string;
      title: string;
      seed: { name: string; slug: string; text: string; kind?: Source["kind"] };
      pick: { name: string; slug: string; text: string };
    }
    const SHAPES: Shape[] = [
      {
        id: "0c1478ca",
        shape: "feed-cut stub",
        title: "MHP'nin 100 il bin ilçe projesi Diyarbakır Ergani'de sevinçle karşılandı",
        seed: {
          name: "Haberler.com",
          slug: "haberler-com",
          kind: "aggregator",
          text: "MHP Genel Başkanı Devlet Bahçeli'nin 100 il bin ilçe projesinde Diyarbakır'ın Ergani ilçesinin adının geçmesi ilçede memnuniyetle karşılandı. Vatandaşlar ve esnaf, Ergani'nin il olmaya uygun olduğunu belirterek projeden duydukları sevinci dile getirdi.",
        },
        pick: {
          name: "Sözcü",
          slug: "sozcu",
          text: "MHP Genel Başkanı Devlet Bahçeli'nin il olmasını önerdiği 19 ilçeden Ergani'de, vatandaşlar öneriyi memnuniyetle karşıla...",
        },
      },
      {
        id: "f6446060",
        shape: "teaser question",
        title: "Michigan'da Müslüman Demokrat Abdul El-Sayed kazandı",
        seed: {
          name: "CGTN Türk",
          slug: "cgtn-turk",
          text: "ABD'de 3 Kasım ara seçimlerinde Michigan'da Demokrat aday Abdul El-Sayed'in, Trump'ın desteklediği Cumhuriyetçi Mike Rogers'ı mağlup ederek Senato yarışını kazandığı bildirildi.",
        },
        pick: {
          name: "DW Türkçe",
          slug: "dw-turkce",
          text: "Michigan'da ipi göğüsleyerek ABD tarihindeki ilk Müslüman senatör olmayı başaran Abdul El-Sayed kimdir?",
        },
      },
      {
        id: "d06e747a",
        shape: "dateline lead",
        title: "Selahattin Demirtaş'ın yargılandığı davada yeni gelişme: Dosyalar birleştirildi",
        seed: {
          name: "Akşam",
          slug: "aksam",
          text: "Eski HDP Eş Genel Başkanı Selahattin Demirtaş'ın Diyarbakır'da 5 ayrı suçtan yargılandığı dava dosyasının Mersin'deki dava dosyasıyla birleştirilmesine karar verildi.",
        },
        pick: {
          name: "Medyascope",
          slug: "medyascope",
          text: "İSTANBUL (Medyascope) – Selahattin Demirtaş’ın Diyarbakır’da 2016’da katıldığı etkinlikler nedeniyle yargılandığı davanın Mersin’deki dosyayla birleştirilmesine karar verildi. Demirtaş hakkında 9 yıldan 15 yıla kadar hapis cezası isteniyor.",
        },
      },
      {
        id: "2b8d3632",
        shape: "glued run-on",
        title: "Cumhurbaşkanı Erdoğan Güney Kore'den ayrıldı",
        seed: {
          name: "Haberler.com",
          slug: "haberler-com",
          kind: "aggregator",
          text: "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae Myung'ın davetine icabetle gerçekleştirdiği resmi ziyaretin ardından başkent Seul'den İstanbul'a hareket etti.",
        },
        pick: {
          name: "Yeni Mesaj",
          slug: "yeni-mesaj",
          text: "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae-myung'un daveti üzerine gerçekleştirdiği resmi ziyaret kapsamındaki temaslarını tamamlayarak Seul'den ayrıldı Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae-myung'un daveti üzerine 8 yıl aradan sonra geldiği Seul'de temaslarını tamamladı. Erdoğan, Seul Seongnam Hava Üssü'nden cumhurbaşkanlığı uçağı \"TUR\" ile Türkiye'ye hareket etti.",
        },
      },
      {
        id: "2441793c",
        shape: "loaded framing",
        title: "İsmail Saymaz ve Murat Ağırel'e 14'er yıl hapis talebi",
        seed: {
          name: "Medyascope",
          slug: "medyascope",
          text: "Murat Ağırel ve İsmail Saymaz hakkında, Ömer Bolat’ın şikâyeti sonrası fon yayını nedeniyle 14 yıl 10 aya kadar hapis istendi.",
        },
        pick: {
          name: "Yeni Akit",
          slug: "yeni-akit",
          text: "Fon soruşturması kapsamında başta Bakan Ömer Bolat olmak üzere bazı bakanlar hakkında iftiralarda bulunan Cumhuriyet yazarları İsmail Saymaz ve Murat Ağırel hakkında “kamu görevlisine görevinden dolayı alenen hakaret”, “iftira”, “halkı yanıltıcı bilgiyi alenen yayma” ve “kişisel verileri hukuka aykırı olarak verme veya ele geçirme” suçlarından ayrı ayrı 14 yıl 10’ar aya kadar hapis cezası talep edildi.",
        },
      },
      {
        id: "ff217744",
        shape: "generic round-up",
        title: "ABD'nin ilk siyahi kadın valisi Georgia eyaletinden Demokrat Keisha Lance Bottoms oldu",
        seed: {
          name: "Anadolu Ajansı",
          slug: "anadolu-ajansi",
          kind: "wire",
          text: "ABD'de oy sayımının sürdüğü ara seçimlerde, Georgia eyaletinde Demokrat aday Keisha Lance Bottoms, ABD'nin ilk siyahi kadın valisi seçildi.",
        },
        pick: {
          name: "Euronews Türkçe",
          slug: "euronews-turkce",
          text: "ABD'de 3 Kasım'da düzenlenen ara seçimler, siyasi dengeleri değiştirmekle kalmadı, ülke tarihinde bir dizi ilke de sahne oldu. İlk kez bir Müslüman Senato'ya seçilirken, yine ilk kez siyah bir kadın ve Amerikan yerlisi bir kadın valilik yarışlarını kazandı.",
        },
      },
      {
        id: "aa12e7c3",
        shape: "dropped fact",
        title: "İsrail Merkez Seçim Komitesi şeffaflığa aykırı bulguya rastlanmadığını açıkladı",
        seed: {
          name: "İşçi Haber",
          slug: "isci-haber",
          kind: "niche",
          text: "İsrail Merkez Seçim Komitesi, 27 Ekim tarihindeki parlamento seçimleri sonrasında yapılan tüm itirazları detaylı şekilde inceledi. Kurul, oylama süreçlerinde şeffaflığa gölge düşürecek herhangi bir usulsüzlük veya bulguya rastlanmadığını açıkladı.",
        },
        pick: {
          name: "CNN Türk",
          slug: "cnn-turk",
          text: "İsrail Merkez Seçim Komitesi, 27 Ekim'de gerçekleştirilen seçimlerin kesin sonuçlarını onayladı.",
        },
      },
      {
        id: "97589454",
        shape: "contradicts the headline",
        title: "Demirtaş ve Yüksekdağ için cezaevleri önünde açıklama yapılacak",
        seed: {
          name: "Cumhuriyet",
          slug: "cumhuriyet",
          text: "Eski HDP Eş Genel Başkanları Selahattin Demirtaş ve Figen Yüksekdağ'ın da aralarında bulunduğu siyasetçilerin tutuklanmasının 10. yılında, Edirne ve Kandıra cezaevleri önünde açıklama yapılacak. DEM Parti Eş Genel Başkanı Tülay Hatimoğulları Edirne'de, Tuncer Bakırhan ise Kandıra'da konuşacak.",
        },
        pick: {
          name: "ABC Haber",
          slug: "abc-haber",
          text: "Selahattin Demirtaş ve Figen Yüksekdağ'ın tutuklanmalarının 10. yılında DEM Parti Eş Genel Başkanları Tülay Hatimoğulları ve Tuncer Bakırhan iki ismi cezaevinde ziyaret etti. Cezaevi önündeki açıklamalarda tahliye çağrısı yapıldı.",
        },
      },
    ];

    /** The cluster as the replay saw it: the seed and the newest member (attempt 1's pick) among fillers. */
    const build = (shape: Shape) => {
      const seed = outlet(shape.seed.name, shape.seed.slug, "2026-11-04T06:30:00.000Z", shape.seed.text, { kind: shape.seed.kind });
      const pick = outlet(shape.pick.name, shape.pick.slug, "2026-11-04T14:00:00.000Z", shape.pick.text);
      const fillers = [1, 2, 3].map((i) =>
        outlet(`Dolgu ${i}`, `dolgu-${i}`, `2026-11-04T0${7 + i}:00:00.000Z`, `Bugün ${i}. sayfada yer alan başka bir haberin kısa açıklaması burada yer alıyor.`),
      );
      return { seed, pick, members: [pick, ...fillers, seed] };
    };

    it.each(SHAPES.map((s) => [s.id, s.shape, s] as const))(
      "%s (%s): the seed agrees with the headline, so the newest member's text is not shown",
      (_id, _shape, shape) => {
        const { seed, pick, members } = build(shape);
        expect(titleAgreement(shape.title, shape.seed.text)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
        const out = withTitle(members, shape.title, shape.seed.text);
        expect(out).toStrictEqual({ text: shape.seed.text, source: seed.source });
        expect(out?.source).not.toBe(pick.source);
      },
    );

    it.each(SHAPES.filter((s) => ["feed-cut stub", "teaser question", "dateline lead", "glued run-on"].includes(s.shape)).map((s) => [s.id, s.shape, s] as const))(
      "%s (%s): the text is flagged by a quality predicate on its own",
      (_id, _shape, shape) => {
        expect(summaryDefect(shape.pick.text, shape.pick.text)).not.toBeNull();
      },
    );

    /**
     * What stops the pick behind a seed that disagrees with the headline: its own
     * agreement score ("score"), the quality predicates ("predicate"), or nothing
     * ("nothing": the known limit, see the comment above).
     */
    const STOPPED_BY: Record<string, "score" | "predicate" | "nothing"> = {
      "0c1478ca": "score",
      f6446060: "score",
      d06e747a: "score",
      "2b8d3632": "predicate",
      "2441793c": "nothing",
      ff217744: "score",
      aa12e7c3: "score",
      "97589454": "nothing",
    };
    const OFF_TOPIC = "Hava durumu raporuna göre yurdun birçok bölgesinde sağanak yağış etkili olacak ve sıcaklıklar düşecek.";
    const behindADisagreeingSeed = (shape: Shape) => {
      const seed = outlet("Hava Haber", "hava-haber", "2026-11-04T06:30:00.000Z", OFF_TOPIC);
      const pick = outlet(shape.pick.name, shape.pick.slug, "2026-11-04T14:00:00.000Z", shape.pick.text);
      return { seed, pick, out: withTitle([pick, seed], shape.title, OFF_TOPIC) };
    };

    it("the table covers every shape, and the seed of the fixture really disagrees", () => {
      expect(Object.keys(STOPPED_BY).sort()).toEqual(SHAPES.map((s) => s.id).sort());
      for (const shape of SHAPES) {
        expect(titleAgreement(shape.title, OFF_TOPIC)!, shape.id).toBeLessThan(AGREEMENT_LOW);
      }
    });

    it.each(SHAPES.filter((s) => STOPPED_BY[s.id] === "score").map((s) => [s.id, s.shape, s] as const))(
      "%s (%s): behind a seed that disagrees it is still kept out, by its agreement score (under 0.75)",
      (_id, _shape, shape) => {
        expect(titleAgreement(shape.title, shape.pick.text)!).toBeLessThan(AGREEMENT_HIGH);
        const { seed, out } = behindADisagreeingSeed(shape);
        expect(out).toStrictEqual({ text: OFF_TOPIC, source: seed.source });
      },
    );

    it.each(SHAPES.filter((s) => STOPPED_BY[s.id] === "predicate").map((s) => [s.id, s.shape, s] as const))(
      "%s (%s): behind a seed that disagrees it covers the headline fully and only the quality predicates keep it out",
      (_id, _shape, shape) => {
        expect(titleAgreement(shape.title, shape.pick.text)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
        expect(summaryDefect(shape.pick.text, shape.pick.text)).not.toBeNull();
        const { seed, out } = behindADisagreeingSeed(shape);
        expect(out).toStrictEqual({ text: OFF_TOPIC, source: seed.source });
      },
    );

    describe("known limit: tone and meaning are invisible to a token overlap", () => {
      it.each(SHAPES.filter((s) => STOPPED_BY[s.id] === "nothing").map((s) => [s.id, s.shape, s] as const))(
        "%s (%s): clean text in the headline's own words, so behind a seed that disagrees it WINS (only the seed-agrees gate protects a healthy cluster)",
        (_id, _shape, shape) => {
          expect(titleAgreement(shape.title, shape.pick.text)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
          expect(summaryDefect(shape.pick.text, tidySummaryText(shape.pick.text))).toBeNull();
          const { pick, out } = behindADisagreeingSeed(shape);
          expect(out?.source).toBe(pick.source);
          expect(out?.text).toBe(tidySummaryText(shape.pick.text));
        },
      );

      it("2441793c: a clean member that covers the headline better wins over the loaded text, so the limit is the top scorer's tone, not any qualifier's", () => {
        const shape = SHAPES.find((s) => s.id === "2441793c")!;
        const clean = outlet(
          "Temiz Haber",
          "temiz-haber",
          "2026-11-04T08:00:00.000Z",
          "Murat Ağırel ve İsmail Saymaz hakkında 14'er yıl hapis talebi istendi, dava sürüyor.",
        );
        expect(titleAgreement(shape.title, clean.article.description ?? "")).toBe(1);
        const { seed, pick } = behindADisagreeingSeed(shape);
        const out = withTitle([pick, clean, seed], shape.title, OFF_TOPIC);
        expect(out?.source).toBe(clean.source);
      });
    });
  });

  // h34-reader-4: the gate above looks at the SEED's agreement only. A seed that
  // is itself defective in form (78e56dca: a Sözcü feed cut that never says what
  // Hamaney said; b6fe7960: three opening “ and one closing ”) covers half the
  // headline's words and was kept. It now counts as disagreeing, and the gain over
  // it is waived: the candidate still needs 0.75 and every quality predicate.
  describe("9b. a seed that is a feed-cut stub or has unbalanced quotes (h34-reader-4)", () => {
    // 78e56dca (18 kaynak), 4 Kasım 2026. The seed is Sözcü's 123-character cut.
    const HAMANEY_TITLE = "ABD seçimlerinden sonra Hamaney'den ilk açıklama";
    const HAMANEY_SEED =
      "İran Dini Lideri Mücteba Hamaney, ABD ara seçim sonuçlarının Washington'ın İran'a yönelik düşmanca yaklaşımını değiştirm...";
    const HAMANEY_SEED_SHOWN =
      "İran Dini Lideri Mücteba Hamaney, ABD ara seçim sonuçlarının Washington'ın İran'a yönelik düşmanca yaklaşımını…";
    const HAMANEY_MEMBERS: Array<[string, string, string, string, Source["kind"]]> = [
      ["Cumhuriyet", "cumhuriyet", "2026-11-04T11:07:00.000Z", "İran'ın dini lideri Mücteba Hamaney, ABD'de Demokratların Kongre ara seçimlerinde elde ettiği kazanımların Washington'ın Tahran'a yönelik politikalarını değiştirmeyeceğini savundu. ABD yönetimine taviz verilmesinin veya ülkedeki siyasi liderliğin değişmesinin ilişkileri düzelteceğini düşünenlerin \"ağır biçimde yanıldığını\" belirten Hamaney, Washington'ı İran'a karşı onlarca yıldır düşmanca politikalar izlemekle suçladı.", "outlet"],
      ["TRT Haber", "trt-haber", "2026-11-04T12:19:00.000Z", "İran lideri Mücteba Hamaney, ABDdeki ara seçim sonuçlarının ardından, Amerikan siyasetindeki değişikliklerin Washingtonın \"İrana yönelik düşmanlığını\" değiştirmeyeceğini söyledi.", "outlet"],
      ["Diriliş Postası", "dirilis-postasi", "2026-11-04T12:22:14.000Z", "İran lideri Mücteba Hamaney, ABD'deki ara seçim sonuçlarının Washington'ın İran politikasını değiştirmeyeceğini söyleyerek tavize karşı uyardı.", "outlet"],
      ["Evrensel", "evrensel", "2026-11-04T12:19:00.000Z", "İran lideri Mücteba Hamaney, ABD'deki ara seçim sonuçlarının ardından Washington’ın Tahran’a yönelik yaklaşımında bir değişim olmayacağını, bu ülkenin \"İran'a yönelik düşmanlığını\" değiştirmeyeceğini ifade etti.", "outlet"],
      ["Anadolu Ajansı", "anadolu-ajansi", "2026-11-04T12:06:46.000Z", "İran lideri Mücteba Hamaney, ABD'deki ara seçim sonuçlarının ardından, Amerikan siyasi liderliğindeki veya parti dinamiklerindeki değişikliklerin bu ülkenin \"İran'a yönelik düşmanlığını\" değiştirmeyeceğini ifade etti.", "wire"],
    ];
    /** Not in the stored cluster: a member whose text says it with the headline's own words. */
    const HAMANEY_AGREES =
      "İran lideri Mücteba Hamaney, ABD seçimlerinden sonra yaptığı ilk açıklamada Washington'ın İran politikasının değişmeyeceğini söyledi.";

    const hamaneyMembers = () => {
      const seed = outlet("Sözcü", "sozcu", "2026-11-04T10:55:56.000Z", HAMANEY_SEED);
      const others = HAMANEY_MEMBERS.map(([name, slug, at, text, kind]) => outlet(name, slug, at, text, { kind }));
      return { seed, others, members: [...others, seed] };
    };

    // b6fe7960 (19 kaynak): Serbestiyet's description, three “ against one ”.
    const VANCE_TITLE = "ABD Başkan Yardımcısı seçim yenilgisini İsrail'e bağladı";
    const VANCE_SEED =
      "ABD Başkan Yardımcısı JD Vance: “Seçimi kaybetmemizin nedeni savaş. Başkan dün gece bunu bizzat söyledi” “Vance 2024’te Trump’a oy verip bu kez Demokratlara yönelen seçmenlerin taleplerini de sıraladı: “Savaşı bitirin. Hayat pahalılığına ve enflasyona odaklanın. Amerika’yı önceleyin. İsrail’le ilişkimizi değiştirin.\nJD Vance bayrak açtı: Seçimi kaybetmemizin nedeni savaş yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
    const VANCE_AKSAM =
      "ABD Başkan Yardımcısı JD Vance, Cumhuriyetçilerin Kongre ara seçimlerinde yaşadığı yenilgiyi İran'la savaşa ve İsrail'le ilişkilere bağladı. Vance, \"Kaybetmemizin nedeni savaştır\" diyerek Trump'ın da bunu dile getirdiğini hatırlattı.";
    const VANCE_DIRILIS =
      "ABD Başkan Yardımcısı JD Vance, Kongre ara seçimlerini Cumhuriyetçi Partinin kaybetmesinin nedenini İran'la savaş ve İsrail'le ilişkilere bağladı.";
    const VANCE_CUMHURIYET =
      "ABD Başkan Yardımcısı James Vance, Cumhuriyetçi Parti'nin ara seçimlerde yaşadığı ağır yenilginin nedeninin İran savaşı olduğunu belirterek, \"Kaybetmemizin nedeni savaş. Başkan Donald Trump da dün gece bunu bizzat söyledi\" dedi.";
    const VANCE_HABERPORT =
      "Vance kaybın sorumlusu olarak İran savaşını gösterdiABD Başkan Yardımcısı James David Vance, Cumhuriyetçi Parti'nin ara seçimlerde yaşadığı ağır yenilginin en önemli nedeninin İran savaşı olduğunu sav...";

    const vanceMembers = () => {
      const seed = outlet("Serbestiyet", "serbestiyet", "2026-11-04T16:24:14.000Z", VANCE_SEED);
      const aksam = outlet("Akşam", "aksam", "2026-11-04T17:06:00.000Z", VANCE_AKSAM);
      const dirilis = outlet("Diriliş Postası", "dirilis-postasi", "2026-11-04T17:17:00.000Z", VANCE_DIRILIS);
      const cumhuriyet = outlet("Cumhuriyet", "cumhuriyet", "2026-11-04T16:57:00.000Z", VANCE_CUMHURIYET);
      const haberport = outlet("Haberport", "haberport", "2026-11-04T16:57:41.000Z", VANCE_HABERPORT);
      return { seed, aksam, dirilis, cumhuriyet, haberport, members: [haberport, dirilis, aksam, cumhuriyet, seed] };
    };

    it("the fixtures are what the cases below assume", () => {
      // 78e56dca: the seed covers exactly half of the headline, so the old gate kept it.
      expect(HAMANEY_SEED).toHaveLength(123);
      expect(tidySummaryText(HAMANEY_SEED)).toBe(HAMANEY_SEED_SHOWN);
      expect(titleAgreement(HAMANEY_TITLE, HAMANEY_SEED_SHOWN)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      expect(seedDisqualified(HAMANEY_SEED, HAMANEY_SEED_SHOWN)).toBe("stub");
      for (const [name, , , text] of HAMANEY_MEMBERS) {
        expect(titleAgreement(HAMANEY_TITLE, text)!, name).toBeLessThan(AGREEMENT_HIGH);
      }
      expect(titleAgreement(HAMANEY_TITLE, HAMANEY_AGREES)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(summaryDefect(HAMANEY_AGREES, HAMANEY_AGREES)).toBeNull();
      // b6fe7960: a seed at 5/7 with unbalanced quotes; two members at or above 0.75.
      const shown = tidySummaryText(VANCE_SEED);
      expect(titleAgreement(VANCE_TITLE, shown)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      expect(seedDisqualified(VANCE_SEED, shown)).toBe("quotes");
      expect(titleAgreement(VANCE_TITLE, VANCE_AKSAM)).toBe(1);
      expect(titleAgreement(VANCE_TITLE, VANCE_DIRILIS)!).toBeCloseTo(6 / 7, 10);
      expect(titleAgreement(VANCE_TITLE, VANCE_CUMHURIYET)!).toBeLessThan(AGREEMENT_HIGH);
      expect(summaryDefect(VANCE_HABERPORT, tidySummaryText(VANCE_HABERPORT))).toBe("stub");
    });

    it("1. 78e56dca: the stub is replaced by a member that agrees, although the stub covers half of the headline", () => {
      const { members } = hamaneyMembers();
      const agrees = outlet("Habertürk", "haberturk", "2026-11-04T12:03:40.000Z", HAMANEY_AGREES);
      const out = withTitle([agrees, ...members], HAMANEY_TITLE, HAMANEY_SEED);
      expect(out).toStrictEqual({ text: HAMANEY_AGREES, source: agrees.source });
    });

    it("1. the same stub with the same members and no title (rss.xml, the digest, the cards): the seed, as before", () => {
      const { seed, members } = hamaneyMembers();
      const agrees = outlet("Habertürk", "haberturk", "2026-11-04T12:03:40.000Z", HAMANEY_AGREES);
      const all = [agrees, ...members];
      expect(summaryAttribution({ summary: HAMANEY_SEED, members: all, wire: notWire })).toStrictEqual({
        text: HAMANEY_SEED_SHOWN,
        source: seed.source,
      });
      expect(
        resolveSummaryAttribution({ summary: HAMANEY_SEED, members: all, lookupFailed: false, wire: notWire }),
      ).toStrictEqual({ text: HAMANEY_SEED_SHOWN, source: seed.source });
      expect(summaryAttributionWithoutMembers({ summary: HAMANEY_SEED, wire: notWire })).toStrictEqual({
        text: HAMANEY_SEED_SHOWN,
        source: null,
      });
    });

    it("2. b6fe7960: the summary with three “ and one ” gives way to the best clean member", () => {
      const { members, aksam } = vanceMembers();
      const out = withTitle(members, VANCE_TITLE, VANCE_SEED);
      expect(out).toStrictEqual({ text: VANCE_AKSAM, source: aksam.source });
      // The meta description follows the page: no unbalanced quotation in it.
      const description = describeForMeta({ count: members.length, attribution: out });
      expect(description.startsWith("5 kaynak. Akşam: ABD Başkan Yardımcısı JD Vance")).toBe(true);
      expect(description).not.toContain("“");
    });

    it("2. without Akşam the next member at or above 0.75 is chosen; without both, the seed stays", () => {
      const { members, dirilis, seed } = vanceMembers();
      const noAksam = members.filter((m) => m.source.slug !== "aksam");
      expect(withTitle(noAksam, VANCE_TITLE, VANCE_SEED)).toStrictEqual({ text: VANCE_DIRILIS, source: dirilis.source });
      const neither = noAksam.filter((m) => m.source.slug !== "dirilis-postasi");
      expect(withTitle(neither, VANCE_TITLE, VANCE_SEED)).toStrictEqual({
        text: tidySummaryText(VANCE_SEED),
        source: seed.source,
      });
    });

    it("2. the pick does not depend on the member order", () => {
      const { members, aksam } = vanceMembers();
      for (const order of [members, [...members].reverse()]) {
        expect(withTitle(order, VANCE_TITLE, VANCE_SEED)?.source).toBe(aksam.source);
      }
    });

    it("3. 78e56dca as stored: no member reaches 0.75, so the stub stays and the summary is never blanked", () => {
      const { seed, members } = hamaneyMembers();
      expect(withTitle(members, HAMANEY_TITLE, HAMANEY_SEED)).toStrictEqual({
        text: HAMANEY_SEED_SHOWN,
        source: seed.source,
      });
    });

    it("3. a title with fewer than 3 content tokens carries no signal: the defective seed stays", () => {
      const { seed, members } = hamaneyMembers();
      const agrees = outlet("Habertürk", "haberturk", "2026-11-04T12:03:40.000Z", HAMANEY_AGREES);
      for (const title of ["Hamaney açıklama", "ve ile bir", "Hamaney"]) {
        expect(withTitle([agrees, ...members], title, HAMANEY_SEED)).toStrictEqual({
          text: HAMANEY_SEED_SHOWN,
          source: seed.source,
        });
      }
    });

    describe("the gain over the seed is waived, the candidate's 0.75 is not (an 8-token title)", () => {
      const WORDS = ["elma", "armut", "kiraz", "üzüm", "incir", "çilek", "muz", "nar"];
      const TITLE8 = WORDS.join(" ");
      const sentence = (hits: number) =>
        `${WORDS.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi.`;
      /** A cut text with no verb in it that carries the first `hits` title words. */
      const stub = (hits: number) =>
        `${WORDS.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmeler ve uzmanların görüşleri…`;
      const run = (seedText: string, candidateText: string) => {
        const seed = outlet("Tohum", "tohum", SEED_AT, seedText);
        const candidate = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", candidateText);
        return { seed, candidate, out: withTitle([candidate, seed], TITLE8, seedText) };
      };

      it("the fixture scores what it says", () => {
        for (let hits = 0; hits <= 8; hits++) {
          expect(titleAgreement(TITLE8, stub(hits)), `stub ${hits}`).toBe(hits / 8);
          expect(titleAgreement(TITLE8, sentence(hits)), `sentence ${hits}`).toBe(hits / 8);
        }
        expect(seedDisqualified(stub(6), stub(6))).toBe("stub");
        expect(summaryDefect(sentence(6), sentence(6))).toBeNull();
      });

      it("a stub at 0.75 gives way to a clean 0.75 (a gain of 0)", () => {
        const r = run(stub(6), sentence(6));
        expect(r.out?.source).toBe(r.candidate.source);
      });

      it("a stub at 1.0 gives way to a clean 0.75 (a negative gain): the form decides", () => {
        const r = run(stub(8), sentence(6));
        expect(r.out?.source).toBe(r.candidate.source);
      });

      it("below 0.75 the candidate does not qualify: 5/8 leaves the stub", () => {
        const r = run(stub(6), sentence(5));
        expect(r.out?.source).toBe(r.seed.source);
      });

      it("the same texts with a clean seed at 0.75: the seed is kept whatever the candidate", () => {
        const r = run(`${sentence(6).slice(0, -1)} (seed).`, sentence(8));
        expect(r.out?.source).toBe(r.seed.source);
      });
    });

    describe("4. a clean seed that covers half of the headline is never replaced", () => {
      const WORDS = ["elma", "armut", "kiraz", "üzüm", "incir", "çilek", "muz", "nar"];
      const TITLE8 = WORDS.join(" ");
      const best = `${WORDS.join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi.`;
      const kept = (seedText: string) => {
        const seed = outlet("Tohum", "tohum", SEED_AT, seedText);
        const candidate = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", best);
        expect(titleAgreement(TITLE8, tidySummaryText(seedText))!, seedText).toBeGreaterThanOrEqual(AGREEMENT_LOW);
        return withTitle([candidate, seed], TITLE8, seedText)?.source === seed.source;
      };

      it.each([
        ["an ellipsis after a sentence that has its verb", "elma armut kiraz üzüm hakkında şehir genelinde yeni gelişmeler yaşandığı bildirildi…"],
        ["three dots after a clause that has its verb", "elma armut kiraz üzüm hakkında şehir genelinde uzmanlar açıklama yaptı..."],
        ["balanced curly quotes", "elma armut kiraz üzüm hakkında “şehir genelinde yeni gelişmeler” yaşandığı bildirildi."],
        ["balanced straight quotes", 'elma armut kiraz üzüm hakkında "şehir genelinde yeni gelişmeler" yaşandığı bildirildi.'],
        ["apostrophes and single curly quotes", "elma armut kiraz üzüm hakkında ‘şehir’ genelinde Ankara’daki yeni gelişmeler yaşandığı bildirildi."],
        ["an ellipsis in the middle", "elma armut kiraz üzüm hakkında şehir genelinde ... yeni gelişmeler yaşandığı bildirildi."],
      ])("%s", (_label, seedText) => {
        expect(kept(seedText)).toBe(true);
      });

      it("a 500-character ingest clamp that the tidy step cut back to a sentence end", () => {
        const one = "elma armut kiraz üzüm hakkında şehir genelinde yeni gelişmeler yaşandığı bildirildi.";
        const two = "Uzmanlar durumu değerlendirdi ve yetkililer açıklama yapacağını duyurdu.";
        let body = "";
        for (let i = 0; body.length < 560; i++) body += `${i % 2 === 0 ? one : two} `;
        const raw = `${body.slice(0, 497)}...`;
        expect(raw).toHaveLength(500);
        expect(tidySummaryText(raw).endsWith("…")).toBe(false);
        expect(kept(raw)).toBe(true);
      });
    });

    describe("5. the seed's form: every shape is replaced by a clean member, alone", () => {
      const WORDS = ["elma", "armut", "kiraz", "üzüm", "incir", "çilek", "muz", "nar"];
      const TITLE8 = WORDS.join(" ");
      const clean = `${WORDS.slice(0, 7).join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi.`;
      const SEED_SHAPES: Array<[string, string]> = [
        ["a cut with no verb", "elma armut kiraz üzüm hakkında şehir genelinde yeni gelişmeler ve uzmanların açıklama..."],
        ["an ellipsis character", "elma armut kiraz üzüm hakkında şehir genelinde yeni gelişmeler ve uzmanların açıklamaları…"],
        ["an opener with no closer", "elma armut kiraz üzüm hakkında “şehir genelinde yeni gelişmeler yaşandığı bildirildi."],
        ["a closer with no opener", "elma armut kiraz üzüm hakkında şehir genelinde yeni gelişmeler yaşandığı bildirildi.”"],
        ["an odd straight quote", 'elma armut kiraz üzüm hakkında "şehir genelinde yeni gelişmeler yaşandığı bildirildi.'],
        ["two openers and a closer", "elma “armut kiraz üzüm” hakkında “şehir genelinde yeni gelişmeler yaşandığı bildirildi."],
      ];

      it.each(SEED_SHAPES)("%s", (_label, seedText) => {
        expect(titleAgreement(TITLE8, tidySummaryText(seedText))!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
        const seed = outlet("Tohum", "tohum", SEED_AT, seedText);
        const candidate = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", clean);
        expect(withTitle([candidate, seed], TITLE8, seedText)).toStrictEqual({ text: clean, source: candidate.source });
        // Alone, the shape stays: the summary is never blanked.
        expect(withTitle([seed], TITLE8, seedText)).toStrictEqual({
          text: tidySummaryText(seedText),
          source: seed.source,
        });
      });
    });

    describe("6. the candidate keeps every quality bar behind a defective seed", () => {
      const TITLE_8 = TITLE;
      // A defective seed that still agrees with the headline: a cut with no verb, 6/9 of TITLE.
      const SEED_STUB = "Michigan'da Senato seçimini kazanan Abdul El Sayed, ABD'de Senato'ya seçilen ilk Müslüman…";
      const stubSeed = () => outlet("TRT Haber", "trt-haber", SEED_AT, SEED_STUB);

      it("the fixture is what the cases below assume", () => {
        expect(titleAgreement(TITLE_8, SEED_STUB)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
        expect(seedDisqualified(SEED_STUB, SEED_STUB)).toBe("stub");
      });

      it("a feed-cut stub, a teaser, a dateline and a run-on never stand in; a clean member does", () => {
        const hazards: Array<[string, string]> = [
          ["a feed-cut stub", STUB_TEXT],
          ["a teaser question", TEASER_TEXT],
          ["a dateline", DATELINE_TEXT],
          ["a glued run-on", RUN_ON_TEXT],
        ];
        for (const [label, text] of hazards) {
          const seed = stubSeed();
          const hazard = outlet("Tuzak", "tuzak", "2026-11-04T09:00:00.000Z", text);
          expect(withTitle([hazard, seed], TITLE_8, SEED_STUB), label).toStrictEqual({ text: SEED_STUB, source: seed.source });
          const clean = dw();
          expect(withTitle([hazard, clean, seed], TITLE_8, SEED_STUB), label).toStrictEqual({ text: DW_TEXT, source: clean.source });
        }
      });

      it("a member that itself has unbalanced quotes (or a cut) is no better than the seed", () => {
        const open = `“${HABER7_TEXT}`;
        const odd = `${HABER7_TEXT.slice(0, 20)} "${HABER7_TEXT.slice(20)}`;
        for (const text of [open, odd, `${HABER7_TEXT}”`]) {
          const seed = stubSeed();
          const bad = outlet("Bozuk", "bozuk", "2026-11-04T09:00:00.000Z", text);
          expect(titleAgreement(TITLE_8, text)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
          expect(withTitle([bad, seed], TITLE_8, SEED_STUB)).toStrictEqual({ text: SEED_STUB, source: seed.source });
          const clean = haber7();
          expect(withTitle([bad, clean, seed], TITLE_8, SEED_STUB)?.source).toBe(clean.source);
        }
      });

      it("another outlet's copy of the seed's own text is not a replacement", () => {
        const seed = stubSeed();
        const copy = outlet("Kopyacı", "kopyaci", "2026-11-04T09:00:00.000Z", SEED_STUB);
        const tidiedCopy = outlet("Kopyacı 2", "kopyaci-2", "2026-11-04T09:10:00.000Z", `${SEED_STUB} Devamı için tıklayınız`);
        expect(withTitle([tidiedCopy, copy, seed], TITLE_8, SEED_STUB)).toStrictEqual({ text: SEED_STUB, source: seed.source });
        const odd = 'Michigan\'da "Senato seçimini kazanan Abdul El Sayed, ABD\'de Senato\'ya seçilen ilk Müslüman oldu.';
        const oddSeed = outlet("TRT Haber", "trt-haber", SEED_AT, odd);
        const oddCopy = outlet("Kopyacı", "kopyaci", "2026-11-04T09:00:00.000Z", odd);
        expect(titleAgreement(TITLE_8, odd)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
        expect(withTitle([oddCopy, oddSeed], TITLE_8, odd)).toStrictEqual({ text: odd, source: oddSeed.source });
      });

      it.each([
        ["wire kind", { kind: "wire" as const }],
        ["aggregator kind", { kind: "aggregator" as const }],
        ["a source that asked not to be excerpted", { allowed: false }],
      ])("%s is skipped", (_label, extra) => {
        const seed = stubSeed();
        const strong = outlet("Aday", "aday", "2026-11-04T09:00:00.000Z", TURKIYE_TEXT, extra);
        expect(withTitle([strong, seed], TITLE_8, SEED_STUB)).toStrictEqual({ text: SEED_STUB, source: seed.source });
        const next = dw();
        expect(withTitle([strong, next, seed], TITLE_8, SEED_STUB)?.source).toBe(next.source);
      });

      it("a near copy of a wire member's text is the agency's: skipped", () => {
        const seed = stubSeed();
        const agency = outlet("Ajans", "ajans", "2026-11-04T08:00:00.000Z", TURKIYE_TEXT, { kind: "wire" });
        const copier = outlet(
          "Kopyacı",
          "kopyaci",
          "2026-11-04T09:00:00.000Z",
          "ABD’deki ara seçimlerde Michigan eyaletinde, Müslüman aday Abdul el-Sayed, Cumhuriyetçi rakibi Mike Rogers’a üstünlük sağlayarak ABD Senatosuna seçilen ilk Müslüman oldu.",
        );
        expect(withTitle([copier, agency, seed], TITLE_8, SEED_STUB)).toStrictEqual({ text: SEED_STUB, source: seed.source });
      });

      it("a member in another language, a wire-majority hash and a short text are skipped", () => {
        const seed = stubSeed();
        const english = outlet(
          "Daily Sabah",
          "daily-sabah",
          "2026-11-04T09:00:00.000Z",
          "Abdul El Sayed won the Michigan race and became the first Muslim elected to the Senate, ABD Senato ilk Müslüman Abdul El Sayed.",
        );
        const short = outlet("Kısa", "kisa", "2026-11-04T09:05:00.000Z", "Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu.");
        const dispatchA = outlet("A", "a", "2026-11-04T09:10:00.000Z", TURKIYE_TEXT, { hash: "dispatch" });
        const dispatchB = outlet("B", "b", "2026-11-04T09:20:00.000Z", null, { hash: "dispatch" });
        const dispatchC = outlet("C", "c", "2026-11-04T09:30:00.000Z", null, { hash: "dispatch" });
        seed.article.content_hash = "own";
        expect(withTitle([english, short, seed], TITLE_8, SEED_STUB)).toStrictEqual({ text: SEED_STUB, source: seed.source });
        expect(withTitle([dispatchA, dispatchB, dispatchC, seed], TITLE_8, SEED_STUB, wireDispatch)).toStrictEqual({
          text: SEED_STUB,
          source: seed.source,
        });
      });
    });

    describe("7. the gates in front of the choice are untouched", () => {
      it("a defective seed that every holder asked not to be excerpted is still hidden", () => {
        const blocked = outlet("Engelli", "engelli", SEED_AT, HAMANEY_SEED, { allowed: false });
        const agrees = outlet("Habertürk", "haberturk", "2026-11-04T12:03:40.000Z", HAMANEY_AGREES);
        expect(withTitle([agrees, blocked], HAMANEY_TITLE, HAMANEY_SEED)).toBeNull();
      });

      it("a defective seed that is the wire dispatch's copy is still hidden", () => {
        const { members } = vanceMembers();
        const seed = members.find((m) => m.source.slug === "serbestiyet")!;
        seed.article.content_hash = "dispatch";
        members.filter((m) => m.source.slug !== "serbestiyet").slice(0, 2).forEach((m) => {
          m.article.content_hash = "dispatch";
        });
        expect(withTitle(members, VANCE_TITLE, VANCE_SEED, wireDispatch)).toBeNull();
        expect(withTitle(members, VANCE_TITLE, VANCE_SEED, notWire)?.source?.slug).toBe("aksam");
      });

      it("a blank summary and a summary no member holds behave as before", () => {
        const { members } = vanceMembers();
        expect(withTitle(members, VANCE_TITLE, "   ")).toBeNull();
        const stored = 'Başka bir metin, hiçbir üyenin açıklaması olmayan, "saklanmış bir özet metni.';
        expect(withTitle(members, VANCE_TITLE, stored)).toStrictEqual({ text: stored, source: null });
      });

      it("does not mutate its inputs", () => {
        const { members } = vanceMembers();
        const before = JSON.stringify(members);
        withTitle(members, VANCE_TITLE, VANCE_SEED);
        expect(JSON.stringify(members)).toBe(before);
      });
    });

    it("8. a big roster (1,000 members) behind a defective seed is scored in one linear pass", () => {
      const { members, aksam } = vanceMembers();
      for (let i = 0; i < 1000; i++) {
        members.push(
          outlet(`Kaynak ${i}`, `kaynak-${i}`, `2026-11-04T18:${String(i % 60).padStart(2, "0")}:00.000Z`, `Başka bir olay ${i} hakkında ayrıntılı bilgi veren ve konuyla ilgisi olmayan uzun bir açıklama metni.`),
        );
      }
      const start = Date.now();
      const out = withTitle(members, VANCE_TITLE, VANCE_SEED);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out?.source).toBe(aksam.source);
    });
  });

  // h54-editorial-1: the gate above reads the seed's WORDS. b34a5fe0 (21 kaynak,
  // 5-6 Kasım 2026): the neutral title says "tutuklandı", the seed (GZT, the
  // earliest member) says "tutuklama talebiyle mahkemeye sevk edildi". "tutuklama"
  // and "tutuklandı" are both the stem "tutuk", so the seed covers 6 of the 7
  // title stems and was kept. A headline that reports a LATER stage of the story
  // than the seed (summary-agreement.ts, stageBehindTitle) now counts the seed as
  // disagreeing, like a stub: the gain is waived and a member that states the
  // outcome, and is not itself at the earlier stage, replaces it.
  describe("9c. a seed that reports an earlier stage than the headline (h54-editorial-1)", () => {
    const KAYA_TITLE = "Fon soruşturmasında Fatma Betül Sayan Kaya tutuklandı";
    // The GZT seed of b34a5fe0, verbatim ("Beyül" is the feed's typo).
    const KAYA_SEED =
      "İstanbul Cumhuriyet Başsavcılığı tarafından yürütülen fon soruşturması kapsamında; Fatma Beyül Sayan Kaya tutuklama talebiyle mahkemeye sevk edildi Eski SPK Başkanı İbrahim Ömer Gönül ve İlyas Kaya adli kontrolle mahkemeye sevk edildi.";
    const KAYA_CUMHURIYET =
      "Fon vurgunun yeni bir gelişme yaşandı. Fatma Betül Sayan Kaya tutuklama talebiyle sulh ceza hakimliğine sevk edildi.";
    const KAYA_MEDYASCOPE =
      "Fon krizi soruşturması kapsamında yeniden ifade veren eski bakan Fatma Betül Sayan Kaya, tutuklanarak cezaevine gönderildi.";
    const KAYA_HABER_COM =
      "Fatma Betül Sayan Kaya fon soruşturmasında tutuklandı. İlyas Kaya ve eski SPK Başkanı İbrahim Ömer Gönül adli kontrol şartıyla serbest bırakıldı.";
    // haberler-com, an aggregator: it states the REQUEST for the arrest ("tutuklanması ... istendi").
    const KAYA_HABERLER =
      "İstanbul Cumhuriyet Başsavcılığı tarafından yürütülen fon soruşturmasında eski Aile ve Sosyal Politikalar Bakanı Fatma Betül Sayan Kaya'nın eşi İlyas Kaya hakkında adli kontrol talep edildi. İlyas Kaya, yurt dışına çıkış yasağı ve imza yükümlülüğü uygulanması talebiyle hakimliğe sevk edildi. Aynı soruşturma kapsamında Fatma Betül Sayan Kaya'nın tutuklanması, eski SPK Başkanı İbrahim Ömer Gönül hakkında ise adli kontrol uygulanması istendi.";
    // Covers all seven title stems and never says whether she was arrested.
    const KAYA_SILENT =
      "Fon soruşturmasında Fatma Betül Sayan Kaya hakkında karar bekleniyor, tutuklama kararı henüz çıkmadı.";

    const gzt = () => outlet("GZT", "gzt", "2026-11-05T19:42:12.000Z", KAYA_SEED);
    const cumhuriyet = () => outlet("Cumhuriyet", "cumhuriyet", "2026-11-05T19:46:00.000Z", KAYA_CUMHURIYET);
    const medyascope = () => outlet("Medyascope", "medyascope", "2026-11-05T22:59:00.000Z", KAYA_MEDYASCOPE);
    const haberCom = () => outlet("Haber.com", "haber-com", "2026-11-06T09:06:57.000Z", KAYA_HABER_COM);
    const haberler = () =>
      outlet("Haberler.com", "haberler-com", "2026-11-05T20:18:42.000Z", KAYA_HABERLER, { kind: "aggregator" });

    it("the fixtures are what the cases below assume", () => {
      // The old gate keeps the seed: it covers 6 of the 7 title stems and is well formed.
      expect(titleAgreement(KAYA_TITLE, KAYA_SEED)!).toBeCloseTo(6 / 7, 10);
      expect(titleAgreement(KAYA_TITLE, KAYA_SEED)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      expect(seedDisqualified(KAYA_SEED, tidySummaryText(KAYA_SEED))).toBeNull();
      // Cumhuriyet agrees as well as the seed does and is at the same stage; the two
      // members that state the outcome cover the whole title.
      expect(titleAgreement(KAYA_TITLE, KAYA_CUMHURIYET)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(titleAgreement(KAYA_TITLE, KAYA_MEDYASCOPE)).toBe(1);
      expect(titleAgreement(KAYA_TITLE, KAYA_HABER_COM)).toBe(1);
      expect(titleAgreement(KAYA_TITLE, KAYA_SILENT)).toBe(1);
      for (const text of [KAYA_SEED, KAYA_CUMHURIYET, KAYA_MEDYASCOPE, KAYA_HABER_COM, KAYA_SILENT]) {
        expect(summaryDefect(text, tidySummaryText(text)), text).toBeNull();
      }
    });

    it("b34a5fe0: the seed with the request is replaced by a member that states the arrest (newest on a tie)", () => {
      const members = [gzt(), cumhuriyet(), medyascope(), haberCom(), haberler()];
      const out = withTitle(members, KAYA_TITLE, KAYA_SEED);
      expect(out).toStrictEqual({ text: KAYA_HABER_COM, source: members[3]!.source });
      expect(out?.text).toContain("tutuklan");
      expect(out?.text).not.toContain("talebiyle");
      // The meta description follows the page.
      const description = describeForMeta({ count: members.length, attribution: out });
      expect(description.startsWith("5 kaynak. Haber.com: Fatma Betül Sayan Kaya fon soruşturmasında tutuklandı")).toBe(true);
      expect(description).not.toContain("talebiyle");
    });

    it("the member at the same stage as the seed never stands in, although it covers 6 of the 7 title stems", () => {
      const members = [gzt(), cumhuriyet(), medyascope()];
      expect(withTitle(members, KAYA_TITLE, KAYA_SEED)?.source?.slug).toBe("medyascope");
      // Without anyone who states the arrest the seed stays: never blank.
      const seed = gzt();
      const out = withTitle([seed, cumhuriyet(), haberler()], KAYA_TITLE, KAYA_SEED);
      expect(out).toStrictEqual({ text: KAYA_SEED, source: seed.source });
    });

    it("a member that covers the title but never says whether she was arrested does not stand in", () => {
      const seed = gzt();
      const silent = outlet("Sessiz", "sessiz", "2026-11-06T08:00:00.000Z", KAYA_SILENT);
      expect(withTitle([seed, silent], KAYA_TITLE, KAYA_SEED)).toStrictEqual({ text: KAYA_SEED, source: seed.source });
      // With a member that does state it, that one wins over the newer silent one.
      expect(withTitle([seed, silent, medyascope()], KAYA_TITLE, KAYA_SEED)?.source?.slug).toBe("medyascope");
    });

    it("the pick does not depend on the member order", () => {
      const members = [gzt(), cumhuriyet(), medyascope(), haberCom(), haberler()];
      for (const order of [members, [...members].reverse(), [members[3]!, members[0]!, members[4]!, members[2]!, members[1]!]]) {
        expect(withTitle(order, KAYA_TITLE, KAYA_SEED)?.source?.slug).toBe("haber-com");
      }
    });

    it("the other gates still apply to a replacement for a stale seed (rights, kind, wire copy, defect, language)", () => {
      const seed = gzt();
      const stays = { text: KAYA_SEED, source: seed.source };
      const blocked = outlet("Medyascope", "medyascope", "2026-11-05T22:59:00.000Z", KAYA_MEDYASCOPE, { allowed: false });
      expect(withTitle([seed, blocked], KAYA_TITLE, KAYA_SEED)).toStrictEqual(stays);
      const wire = outlet("AA", "anadolu-ajansi", "2026-11-05T22:59:00.000Z", KAYA_MEDYASCOPE, { kind: "wire" });
      expect(withTitle([seed, wire], KAYA_TITLE, KAYA_SEED)).toStrictEqual(stays);
      const aggregator = outlet("Agg", "agg", "2026-11-05T22:59:00.000Z", KAYA_MEDYASCOPE, { kind: "aggregator" });
      expect(withTitle([seed, aggregator], KAYA_TITLE, KAYA_SEED)).toStrictEqual(stays);
      const teaser = outlet("Tuzak", "tuzak", "2026-11-05T22:59:00.000Z", `${KAYA_MEDYASCOPE} Peki, Kaya kimdir? Kaç yaşında?`);
      expect(withTitle([seed, teaser], KAYA_TITLE, KAYA_SEED)).toStrictEqual(stays);
      // A wire dispatch's hash is not a candidate's either.
      const dispatch = outlet("Medyascope", "medyascope", "2026-11-05T22:59:00.000Z", KAYA_MEDYASCOPE, { hash: "dispatch" });
      const copy = outlet("Kopya", "kopya", "2026-11-05T23:00:00.000Z", KAYA_CUMHURIYET, { hash: "dispatch" });
      expect(withTitle([seed, dispatch, copy], KAYA_TITLE, KAYA_SEED, wireDispatch)).toStrictEqual(stays);
    });

    // correctness-1: a REQUEST that holds the stem "tutuklan" is not the arrest.
    it("case A: a newer member that only reports the REQUEST ('tutuklanması talep edilen') never stands in for a stale seed", () => {
      const request = outlet(
        "Yeni",
        "yeni",
        "2026-11-06T01:00:00.000Z",
        "Fon soruşturmasında tutuklanması talep edilen Fatma Betül Sayan Kaya, sulh ceza hakimliğine sevk edildi.",
      );
      expect(titleAgreement(KAYA_TITLE, request.article.description ?? "")!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
      expect(withTitle([gzt(), medyascope(), request], KAYA_TITLE, KAYA_SEED)?.source?.slug).toBe("medyascope");
      expect(withTitle([request, medyascope(), gzt()], KAYA_TITLE, KAYA_SEED)?.source?.slug).toBe("medyascope");
      // With nobody who states the arrest the seed stays: never blank.
      const seed = gzt();
      expect(withTitle([seed, request], KAYA_TITLE, KAYA_SEED)).toStrictEqual({ text: KAYA_SEED, source: seed.source });
    });

    it("case B: a headline at the REQUEST stage ('Tutuklanması talep edilen ...') is not an arrest outcome, so the seed is kept", () => {
      const title = "Tutuklanması talep edilen Fatma Betül Sayan Kaya hakimliğe sevk edildi";
      const moved = outlet(
        "Yeni",
        "yeni",
        "2026-11-06T01:00:00.000Z",
        "Fon soruşturmasında hakimliğe sevk edilen Fatma Betül Sayan Kaya tutuklandı.",
      );
      expect(titleAgreement(title, KAYA_SEED)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      const seed = gzt();
      expect(withTitle([seed, moved], title, KAYA_SEED)).toStrictEqual({ text: KAYA_SEED, source: seed.source });
    });

    it("the seed's own text under another outlet's name is not a replacement", () => {
      const seed = gzt();
      const copy = outlet("Kopya", "kopya", "2026-11-06T08:00:00.000Z", KAYA_SEED);
      expect(withTitle([seed, copy], KAYA_TITLE, KAYA_SEED)).toStrictEqual({ text: KAYA_SEED, source: seed.source });
    });

    it("a seed that states the outcome is kept, and so is a seed at the stage the headline reports", () => {
      const outcomeSeed = "Fon soruşturması kapsamında ifade veren Fatma Betül Sayan Kaya tutuklandı. Eşi İlyas Kaya adli kontrolle serbest bırakıldı.";
      const seed = outlet("GZT", "gzt", "2026-11-05T19:42:12.000Z", outcomeSeed);
      expect(withTitle([seed, medyascope(), haberCom()], KAYA_TITLE, outcomeSeed)).toStrictEqual({
        text: outcomeSeed,
        source: seed.source,
      });
      // The headline is at the request stage too: nothing is behind it.
      const requestTitle = "Fon soruşturmasında Fatma Betül Sayan Kaya tutuklama talebiyle sevk edildi";
      const stageSeed = gzt();
      expect(withTitle([stageSeed, cumhuriyet(), medyascope()], requestTitle, KAYA_SEED)).toStrictEqual({
        text: KAYA_SEED,
        source: stageSeed.source,
      });
    });

    it("the surfaces that never pass a title keep the stale seed by design (rss.xml, the digest, the cards)", () => {
      const members = [gzt(), cumhuriyet(), medyascope(), haberCom()];
      const seed = members[0]!;
      expect(summaryAttribution({ summary: KAYA_SEED, members, wire: notWire })).toStrictEqual({
        text: KAYA_SEED,
        source: seed.source,
      });
      expect(
        resolveSummaryAttribution({ summary: KAYA_SEED, members, lookupFailed: false, wire: notWire }),
      ).toStrictEqual({ text: KAYA_SEED, source: seed.source });
    });

    it("a headline with too few content words carries no signal: the seed stays (unchanged rule)", () => {
      const seed = gzt();
      expect(withTitle([seed, medyascope()], "Kaya tutuklandı", KAYA_SEED)).toStrictEqual({
        text: KAYA_SEED,
        source: seed.source,
      });
    });

    it("the death family: a headline that reports the death replaces a seed that reports the injury", () => {
      const title = "Kocaeli'de yangında yaralanan kadın hayatını kaybetti";
      const injured = "Kocaeli'de çıkan yangında yaralanan kadın hastaneye kaldırıldı ve yoğun bakıma alındı.";
      const died = "Kocaeli'de çıkan yangında yaralanan kadın, tedavi gördüğü hastanede hayatını kaybetti.";
      expect(titleAgreement(title, injured)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      const seed = outlet("Birinci", "birinci", "2026-11-05T10:00:00.000Z", injured);
      const later = outlet("İkinci", "ikinci", "2026-11-05T14:00:00.000Z", died);
      expect(withTitle([seed, later], title, injured)).toStrictEqual({ text: died, source: later.source });
      // A text at the injury stage is no replacement, and without the death the seed stays.
      const other = outlet("Üçüncü", "ucuncu", "2026-11-05T11:00:00.000Z", "Kocaeli'de çıkan yangında yaralanan kadın ağır yaralı olarak hastaneye kaldırıldı, tedavisi sürüyor.");
      expect(withTitle([seed, other], title, injured)).toStrictEqual({ text: injured, source: seed.source });
    });

    it("the release family: a headline that reports the release replaces a seed that reports the request", () => {
      const title = "Eski SPK Başkanı İbrahim Ömer Gönül adli kontrolle serbest bırakıldı";
      const asked =
        "Eski SPK Başkanı İbrahim Ömer Gönül hakkında adli kontrol şartıyla tahliye talebiyle hakimliğe başvuruldu.";
      const freed = "Eski SPK Başkanı İbrahim Ömer Gönül, adli kontrol şartıyla serbest bırakıldı.";
      expect(titleAgreement(title, asked)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
      const seed = outlet("Birinci", "birinci", "2026-11-05T22:00:00.000Z", asked);
      const later = outlet("İkinci", "ikinci", "2026-11-06T01:00:00.000Z", freed);
      expect(withTitle([seed, later], title, asked)).toStrictEqual({ text: freed, source: later.source });
    });

    it("a big roster (1,000 members) behind a stale seed is scored in one linear pass", () => {
      const members = [gzt(), cumhuriyet(), medyascope()];
      for (let i = 0; i < 1000; i++) {
        members.push(
          outlet(`Kaynak ${i}`, `kaynak-${i}`, `2026-11-05T20:${String(i % 60).padStart(2, "0")}:00.000Z`, `Başka bir olay ${i} hakkında ayrıntılı bilgi veren ve konuyla ilgisi olmayan uzun bir açıklama metni.`),
        );
      }
      const start = Date.now();
      const out = withTitle(members, KAYA_TITLE, KAYA_SEED);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out?.source?.slug).toBe("medyascope");
    });

    it("does not mutate its inputs", () => {
      const members = [gzt(), cumhuriyet(), medyascope(), haberCom(), haberler()];
      const before = JSON.stringify(members);
      withTitle(members, KAYA_TITLE, KAYA_SEED);
      expect(JSON.stringify(members)).toBe(before);
    });
  });

  it("10. the meta description follows the new attribution, not the stale seed", () => {
    const { members } = story();
    const attribution = withTitle(members, TITLE, SEED_TEXT);
    const description = describeForMeta({ count: members.length, attribution });
    expect(description.startsWith("5 kaynak. Türkiye Gazetesi: ABD’deki ara seçimlerde")).toBe(true);
    expect(description).not.toContain("önde götürüyor");
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("11. the surfaces that never pass a title keep the seed: resolveSummaryAttribution and the memberless path", () => {
    const { members, seed } = story();
    expect(
      resolveSummaryAttribution({ summary: SEED_TEXT, members, lookupFailed: false, wire: notWire }),
    ).toStrictEqual({ text: SEED_TEXT, source: seed.source });
    expect(
      resolveSummaryAttribution({ summary: SEED_TEXT, members: undefined, lookupFailed: false, wire: notWire }),
    ).toStrictEqual({ text: SEED_TEXT, source: null });
  });

  it("12. a big roster (1,000 members) is scored in one linear pass", () => {
    const { members } = story();
    for (let i = 0; i < 1000; i++) {
      members.push(
        outlet(`Kaynak ${i}`, `kaynak-${i}`, `2026-11-04T08:${String(i % 60).padStart(2, "0")}:00.000Z`, `Başka bir olay ${i} hakkında ayrıntılı bilgi veren ve konuyla ilgisi olmayan uzun bir açıklama metni.`),
      );
    }
    const start = Date.now();
    const out = withTitle(members, TITLE, SEED_TEXT);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(out?.source?.slug).toBe("turkiye-gazetesi");
  });
});

describe("h48-ingest-1: 'Ayrıntılar geliyor...' placeholders hide the summary like 'Click to continue'", () => {
  const wire = { isWireRedistribution: false };
  const A72F = "Ayrıntılar geliyor...\n\n\n\nKKTC Başbakanı Üstel, KKTC ile ilgili açıklamaları için Cumhurbaşkanı Erdoğan'a teşekkür etti";
  const PLACEHOLDERS = [
    "Ayrıntılar geliyor...",
    "ayrıntılar geliyor...",
    "Detaylar gelecek…",
    "DETAYLAR GELİYOR",
    "Ayrıntılar birazdan...\nKaynak: TRT Haber",
    A72F,
  ];

  it.each(PLACEHOLDERS)("hides %j (members present, members absent, batched lookup)", (summary) => {
    const members = [member("milliyet", T0, summary)];
    expect(summaryAttribution({ summary, members, wire })).toBeNull();
    expect(summaryAttribution({ summary, members, wire, agreeWithTitle: "Üstel Erdoğan'a teşekkür etti" })).toBeNull();
    expect(summaryAttributionWithoutMembers({ summary, wire })).toBeNull();
    expect(resolveSummaryAttribution({ summary, members, lookupFailed: false, wire })).toBeNull();
    expect(resolveSummaryAttribution({ summary, members: undefined, lookupFailed: false, wire })).toBeNull();
  });

  it("the meta / OG / JSON-LD description falls back exactly as it does for 'Click to continue' (fbb078b4)", () => {
    const description = (summary: string) =>
      describeForMeta({
        count: 4,
        attribution: summaryAttribution({ summary, members: [member("milliyet", T0, summary)], wire }),
        title: "Üstel Erdoğan'a teşekkür etti",
      });
    const baseline = description("Click to continue");
    expect(baseline).toBe("4 kaynak, tek haber: Üstel Erdoğan'a teşekkür etti");
    for (const summary of PLACEHOLDERS) {
      expect(description(summary), summary).toBe(baseline);
      expect(description(summary), summary).not.toMatch(/Ayrıntılar|Detaylar|ayrıntılar/);
    }
    // Without a title the fallback is the bare count, again the same as for the CTA.
    const bare = (summary: string) =>
      describeForMeta({
        count: 4,
        attribution: summaryAttribution({ summary, members: [member("milliyet", T0, summary)], wire }),
      });
    expect(bare("Ayrıntılar geliyor...")).toBe(bare("Click to continue"));
    expect(bare("Ayrıntılar geliyor...")).toBe("4 kaynak.");
  });

  it("a summary that merely starts with the phrase is a real summary and still shows", () => {
    const summary = "Ayrıntılar geliyor: Bakan Yılmaz yeni vergi düzenlemesini açıkladı ve gelecek ay yürürlüğe girecek.";
    const shown = summaryAttribution({ summary, members: [member("milliyet", T0, summary)], wire });
    expect(shown?.text).toBe(summary);
    expect(shown?.source?.name).toBe("milliyet");
  });

  it("a placeholder tail behind a real sentence is stripped and the sentence is kept", () => {
    const summary = "Bakan Yılmaz yeni vergi düzenlemesini açıkladı. Ayrıntılar geliyor...";
    const shown = summaryAttribution({ summary, members: [member("milliyet", T0, summary)], wire });
    expect(shown?.text).toBe("Bakan Yılmaz yeni vergi düzenlemesini açıkladı.");
  });
});
