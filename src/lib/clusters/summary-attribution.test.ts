import { describe, it, expect } from "vitest";
import {
  findSeedMember,
  summaryAttribution,
  summaryAttributionWithoutMembers,
  describeForMeta,
  resolveSummaryAttribution,
  summaryLabel,
} from "./summary-attribution";
import type { ClusterDetailMember } from "./cluster-detail-query";
import {
  AGENCY_COPY_OVERLAP,
  AGREEMENT_FORM_DEFECT_MIN,
  AGREEMENT_HIGH,
  AGREEMENT_LOW,
  isLiveLine,
  isQuoteOnly,
  seedDisqualified,
  summaryDefect,
  textOverlap,
  titleAgreement,
} from "./summary-agreement";
import { isHeadlineEcho } from "@/lib/articles/description-boilerplate";
import { tidySummaryText } from "@/lib/articles/summary-tidy";
import type { Source, SourceKind } from "@/types";

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
  // h95-summaries-1: the come-on OPENS the text. Behind a complete sentence of 60 characters or
  // more the tidy step now cuts it ("... ilk Müslüman oldu. Peki, Abdul El Sayed kimdir? ..." shows
  // "... ilk Müslüman oldu."), which leaves nothing to keep out; only a text that opens with it,
  // and so has nothing in front of it to end on, is still a teaser.
  const TEASER_TEXT =
    "Peki, Abdul El Sayed kimdir? Kaç yaşında, aslen nereli? ABD'deki senato seçimlerinde Demokrat Parti adayı Abdul El Sayed, Michigan’daki seçimleri resmen kazanarak Senato’ya seçilen ilk Müslüman oldu.";
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

    it("2. without Akşam the next member at or above 0.6 is chosen; with none left, the seed stays", () => {
      const { members, dirilis, cumhuriyet, seed } = vanceMembers();
      const noAksam = members.filter((m) => m.source.slug !== "aksam");
      expect(withTitle(noAksam, VANCE_TITLE, VANCE_SEED)).toStrictEqual({ text: VANCE_DIRILIS, source: dirilis.source });
      const neither = noAksam.filter((m) => m.source.slug !== "dirilis-postasi");
      // h95-summaries-1: behind a form defect the bar is AGREEMENT_FORM_DEFECT_MIN, and Cumhuriyet's
      // 5 of 7 (0.71, under 0.75) now clears it.
      expect(titleAgreement(VANCE_TITLE, VANCE_CUMHURIYET)!).toBeGreaterThanOrEqual(AGREEMENT_FORM_DEFECT_MIN);
      expect(withTitle(neither, VANCE_TITLE, VANCE_SEED)).toStrictEqual({
        text: VANCE_CUMHURIYET,
        source: cumhuriyet.source,
      });
      const none = neither.filter((m) => m.source.slug !== "cumhuriyet");
      expect(withTitle(none, VANCE_TITLE, VANCE_SEED)).toStrictEqual({
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

    describe("the gain over the seed is waived, the candidate's floor is not: 0.6 behind a form defect (an 8-token title)", () => {
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

      it("below 0.6 the candidate does not qualify: 4/8 leaves the stub", () => {
        const r = run(stub(6), sentence(4));
        expect(r.out?.source).toBe(r.seed.source);
      });

      it("h95-summaries-1: from 0.6 up it does (5/8 is 0.625, 0.75 is no longer the bar behind a form defect)", () => {
        const r = run(stub(6), sentence(5));
        expect(r.out?.source).toBe(r.candidate.source);
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
      // The come-on opens the text (h95-summaries-1: behind a complete sentence the tidy step cuts it).
      const teaser = outlet("Tuzak", "tuzak", "2026-11-05T22:59:00.000Z", `Peki, Kaya kimdir? Kaç yaşında? ${KAYA_MEDYASCOPE}`);
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

// ---------------------------------------------------------------------------
// h54-editorial-3: an opinion column's thesis is not the story's summary. The
// summary of 539e6666 was the Hürriyet column's lead ("TÜRK siyasi tarihinde
// utanmazlıkta yarışacak iki örnek vardır; ...") under "Özet — Hürriyet", with no
// cue that it is a column. A member whose URL is an opinion path (isOpinionUrl)
// is, as the SEED, malformed (the gain over it is waived) and, as a CANDIDATE,
// never a replacement. When the shown summary's member is opinion the label says
// so (summaryLabel); only the cluster page passes a title, so only it can swap.
// ---------------------------------------------------------------------------
describe("h54-editorial-3: opinion members and the summary", () => {
  const notWire = { isWireRedistribution: false };
  const TITLE = "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı";
  // The column's lead covers the whole title: the old rule keeps it.
  const COLUMN_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı; bu yazıda sözlerin ardındaki siyaseti ve yarattığı tartışmayı ele alıyorum.";
  const NEWS_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri üzerine CHP'den açıklama geldi, sözler siyasette tartışma yarattı.";
  const MIRROR_TEXT =
    "Mustafa Sarıgül'ün Özgür Özel'e yönelik sözleri tartışma yarattı; yazar sözlerin sert tonuna dikkat çekiyor ve gerekçelerini sıralıyor.";
  const HURRIYET_COLUMN_URL = "https://www.hurriyet.com.tr/yazarlar/nedim-sener/utanmazlik-abidesi-43365220";
  const SABAH_COLUMN_URL = "https://www.sabah.com.tr/yazarlar/salih-tuna/2026/11/04/anladiysaniz-bana-da-anlatin";
  const NEWS_URL = "https://www.yeniakit.com.tr/haber/sarigul-ozel-2031769.html";

  function outlet(
    name: string,
    slug: string,
    publishedAt: string,
    description: string | null,
    /** null: the member carries no url at all (a lighter projection, the RSS members). */
    url: string | null,
    extra: { kind?: Source["kind"]; allowed?: boolean } = {},
  ): ClusterDetailMember {
    const m = member(slug, publishedAt, description, `hash-${slug}`);
    m.source = { ...src(slug), name, slug, kind: extra.kind ?? "outlet" };
    if (extra.allowed !== undefined) m.source.excerpt_allowed = extra.allowed;
    if (url === null) delete (m.article as { url?: string }).url;
    else m.article.url = url;
    return m;
  }

  const hurriyet = (url: string | null = HURRIYET_COLUMN_URL) =>
    outlet("Hürriyet", "hurriyet", "2026-11-04T03:07:31.000Z", COLUMN_TEXT, url);
  const yeniAkit = (url: string | null = NEWS_URL) =>
    outlet("Yeni Akit", "yeni-akit", "2026-11-04T08:14:00.000Z", NEWS_TEXT, url);
  const sabah = (url: string | null = SABAH_COLUMN_URL) =>
    outlet("Sabah", "sabah", "2026-11-04T09:00:00.000Z", MIRROR_TEXT, url);

  const withTitle = (members: ClusterDetailMember[], summary = COLUMN_TEXT, title = TITLE) =>
    summaryAttribution({ summary, members, wire: notWire, agreeWithTitle: title });

  it("the fixture is what the cases below assume: the column's lead covers the headline, so only its URL can replace it", () => {
    expect(titleAgreement(TITLE, COLUMN_TEXT)).toBe(1);
    expect(titleAgreement(TITLE, NEWS_TEXT)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
    expect(titleAgreement(TITLE, MIRROR_TEXT)!).toBeGreaterThanOrEqual(AGREEMENT_HIGH);
    for (const text of [COLUMN_TEXT, NEWS_TEXT, MIRROR_TEXT]) {
      expect(summaryDefect(text, tidySummaryText(text)), text).toBeNull();
      expect(seedDisqualified(text, tidySummaryText(text)), text).toBeNull();
    }
  });

  it("without URLs nothing is known about the members: the covering seed stays (the old rule, byte for byte)", () => {
    const seed = hurriyet(null);
    const out = withTitle([seed, yeniAkit(null)]);
    expect(out).toStrictEqual({ text: COLUMN_TEXT, source: seed.source });
  });

  it("an opinion seed with a qualifying news member is replaced by it, and the news summary carries no column cue", () => {
    const members = [hurriyet(), yeniAkit()];
    const out = withTitle(members);
    expect(out).toStrictEqual({ text: NEWS_TEXT, source: members[1]!.source });
    expect(out).not.toHaveProperty("opinion");
    expect(summaryLabel(out!)).toBe("Özet — Yeni Akit");
  });

  it("the pick does not depend on the member order", () => {
    const members = [hurriyet(), yeniAkit()];
    for (const order of [members, [...members].reverse()]) {
      expect(withTitle(order)?.source?.slug).toBe("yeni-akit");
    }
  });

  it("an opinion seed alone is kept, never blanked, and its label says it is a column", () => {
    const seed = hurriyet();
    const out = withTitle([seed]);
    expect(out).toStrictEqual({ text: COLUMN_TEXT, source: seed.source, opinion: true });
    expect(summaryLabel(out!)).toBe("Özet — Hürriyet · köşe yazısı");
    expect(summaryLabel(out!)).toContain("köşe yazısı");
  });

  it("an opinion member never stands in for an opinion seed: a mirror column is no replacement", () => {
    const seed = hurriyet();
    const out = withTitle([seed, sabah()]);
    expect(out?.source?.slug).toBe("hurriyet");
    expect(out?.text).toBe(COLUMN_TEXT);
    expect(summaryLabel(out!)).toContain("köşe yazısı");
  });

  it("the news member wins over a newer, equally covering mirror column", () => {
    const out = withTitle([hurriyet(), sabah(), yeniAkit()]);
    expect(out?.source?.slug).toBe("yeni-akit");
    expect(out).not.toHaveProperty("opinion");
  });

  it("an opinion member is not a replacement for a NEWS seed that disagrees with the title either", () => {
    const newsSeedText = "Ankara'da bugün hava güneşli geçecek ve sıcaklık mevsim normallerinde seyredecek.";
    const seed = outlet("TRT Haber", "trt-haber", "2026-11-04T01:00:00.000Z", newsSeedText, "https://www.trthaber.com/haber/x-1.html");
    expect(titleAgreement(TITLE, newsSeedText)!).toBeLessThan(AGREEMENT_LOW);
    // The column covers the title completely and is the only member that does.
    const out = withTitle([seed, hurriyet()], newsSeedText);
    expect(out).toStrictEqual({ text: newsSeedText, source: seed.source });
    // Without the opinion URL the same column WOULD have replaced it (the rule is the URL, nothing else).
    expect(withTitle([seed, hurriyet(null)], newsSeedText)?.source?.slug).toBe("hurriyet");
  });

  it("the other gates still stand for the replacement of an opinion seed (rights, aggregator, wire)", () => {
    const seed = hurriyet();
    const stays = { text: COLUMN_TEXT, source: seed.source, opinion: true };
    expect(withTitle([seed, outlet("Yeni Akit", "yeni-akit", "2026-11-04T08:14:00.000Z", NEWS_TEXT, NEWS_URL, { allowed: false })])).toStrictEqual(stays);
    expect(withTitle([seed, outlet("Haberler", "haberler", "2026-11-04T08:14:00.000Z", NEWS_TEXT, NEWS_URL, { kind: "aggregator" })])).toStrictEqual(stays);
    expect(withTitle([seed, outlet("AA", "aa", "2026-11-04T08:14:00.000Z", NEWS_TEXT, NEWS_URL, { kind: "wire" })])).toStrictEqual(stays);
  });

  it("a news member that covers too little of the headline does not replace the opinion seed (AGREEMENT_HIGH still applies)", () => {
    const weak = outlet("Zayıf", "zayif", "2026-11-04T08:14:00.000Z", "CHP'den yeni bir açıklama geldi, ayrıntılar henüz netleşmedi ve konu gündemde.", NEWS_URL);
    expect(titleAgreement(TITLE, weak.article.description ?? "")!).toBeLessThan(AGREEMENT_HIGH);
    const seed = hurriyet();
    expect(withTitle([seed, weak])).toStrictEqual({ text: COLUMN_TEXT, source: seed.source, opinion: true });
  });

  it("a headline with too few content words carries no signal: the opinion seed stays, labelled", () => {
    const seed = hurriyet();
    const out = withTitle([seed, yeniAkit()], COLUMN_TEXT, "Sarıgül konuştu");
    expect(out).toStrictEqual({ text: COLUMN_TEXT, source: seed.source, opinion: true });
  });

  it("the surfaces that pass no title keep the opinion seed and never swap (rss.xml, the digest, the cards)", () => {
    const members = [hurriyet(), yeniAkit()];
    const out = summaryAttribution({ summary: COLUMN_TEXT, members, wire: notWire });
    expect(out?.source?.slug).toBe("hurriyet");
    expect(out?.text).toBe(COLUMN_TEXT);
    expect(resolveSummaryAttribution({ summary: COLUMN_TEXT, members, lookupFailed: false, wire: notWire })?.source?.slug).toBe("hurriyet");
  });

  it("only the shown summary's own member decides the label: an opinion member elsewhere in the roster adds no cue", () => {
    const seed = yeniAkit();
    const out = withTitle([seed, hurriyet()], NEWS_TEXT);
    expect(out).toStrictEqual({ text: NEWS_TEXT, source: seed.source });
    expect(summaryLabel(out!)).toBe("Özet — Yeni Akit");
  });

  it("a summary no member holds ('Kaynak açıklaması') names no outlet and carries no column cue", () => {
    const out = withTitle([hurriyet(), yeniAkit()], "Hiçbir üyenin açıklaması olmayan, saklanmış bir özet metni.");
    expect(out).toStrictEqual({ text: "Hiçbir üyenin açıklaması olmayan, saklanmış bir özet metni.", source: null });
    expect(summaryLabel(out!)).toBe("Özet — Kaynak açıklaması");
  });

  it("summaryLabel: the plain label, the column label and the unattributed label, exactly", () => {
    const m = yeniAkit();
    expect(summaryLabel({ text: "x", source: m.source })).toBe("Özet — Yeni Akit");
    expect(summaryLabel({ text: "x", source: m.source, opinion: true })).toBe("Özet — Yeni Akit · köşe yazısı");
    expect(summaryLabel({ text: "x", source: null })).toBe("Özet — Kaynak açıklaması");
  });

  it("does not mutate its inputs, and a 1,000-member roster is still one linear pass", () => {
    const members = [hurriyet(), sabah(), yeniAkit()];
    const before = JSON.stringify(members);
    withTitle(members);
    expect(JSON.stringify(members)).toBe(before);

    for (let i = 0; i < 1000; i++) {
      members.push(
        outlet(`Kaynak ${i}`, `kaynak-${i}`, `2026-11-04T05:${String(i % 60).padStart(2, "0")}:00.000Z`, `Başka bir olay ${i} hakkında ayrıntılı bilgi veren ve konuyla ilgisi olmayan uzun bir açıklama metni.`, `https://example.com/haber/${i}`),
      );
    }
    const start = Date.now();
    const out = withTitle(members);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(out?.source?.slug).toBe("yeni-akit");
  });
});

// ---------------------------------------------------------------------------
// h95-summaries-1 and h95-summaries-2 (hunt 95, 2026-11-09)
//
// summaries-1: the Özet kept a bad seed (a live-blog line, a Peki / İşte teaser, an
// echo of the headline, a stub that a surname hid, a cut with no ellipsis), and every
// clean replacement still needed 0.75. summaries-2: among members with an identical
// description the earliest stamp won whatever the source kind, so an aggregator was
// credited with the state agency's lead.
//
// The members below are the real outlet texts of the live clusters (dumped read-only
// 2026-11-09), trimmed to the members each case needs.
// ---------------------------------------------------------------------------

function fx(name: string, slug: string, kind: SourceKind, at: string, description: string, title: string): ClusterDetailMember {
  return {
    source: { ...src(slug), name, kind },
    article: { id: `${slug}@${at}`, title, url: `https://example.com/${slug}`, published_at: at, image_url: null, content_hash: `h-${slug}`, description },
  };
}

const NOT_WIRE = { isWireRedistribution: false };

function resolve(title: string, summary: string, members: ClusterDetailMember[]) {
  return summaryAttribution({ summary, members, wire: NOT_WIRE, agreeWithTitle: title });
}

function byName(members: ClusterDetailMember[], name: string): ClusterDetailMember {
  const m = members.find((x) => x.source.name === name);
  if (!m) throw new Error(`no member ${name}`);
  return m;
}

/** What the page shows for a member's own description. */
function shownOf(m: ClusterDetailMember): string {
  return tidySummaryText(m.article.description ?? "");
}

// 459a7b61: neutral title "Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar"
const H45_TITLE = "Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar";
const H45_SUMMARY = "HABER MERKEZİ- İşte Erdoğan'ın açıklamalarından öne çıkan satır başları:";
const H45_MEMBERS = [
  fx("Milliyet", "milliyet", "outlet", "2026-11-08T11:56:47Z", "HABER MERKEZİ- İşte Erdoğan'ın açıklamalarından öne çıkan satır başları:", "Son dakika... Cumhurbaşkanı Erdoğan: Bakü'nün sevinci Ankara'nın sevincidir"),
  fx("Akşam", "aksam", "outlet", "2026-11-08T11:58:00Z", "Şuşa'da Azerbaycan Cumhurbaşkanı İlham Aliyev ile ortak basın toplantısı düzenleyen Başkan Erdoğan, Karabağ Zafer Günü'nü 6.yılını kutlayarak, \" Şanlı zafer Azerbaycan'ın haklı davasıdır. Beraberliğimiz her zaman daim olacak. Bakü'nün sevinci Ankara'nın sevincidir\" dedi.", "Bir millet iki devlet! Başkan Erdoğan: Bakü'nün sevinci Ankara'nın sevincidir"),
  fx("A Haber", "a-haber", "outlet", "2026-11-08T11:59:19Z", "Başkan Recep Tayyip Erdoğan Azerbaycan Cumhurbaşkanı İlham Aliyev ile ortak basın toplantısında açıklamalarda bulunuyor. Azerbaycan Cumhurbaşkanı İlham Aliyev, Başkan Recep Tayyip Erdoğan'ın...Devamı için tıklayınız", "Erdoğan ve Aliyev'den Şuşu'da net mesaj: Kardeşliğimiz daim olacak"),
  fx("Haber7", "haber7", "outlet", "2026-11-08T12:05:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan Cumhurbaşkanı Aliyev ile yaptığı ortak toplantıda açıklamalarda bulunuyor.", "Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar"),
];

// b04edded: neutral title "Cumhurbaşkanı Erdoğan: Vizyonumuz sağlıklı Türkiye Yüzyılı"
const B04_TITLE = "Cumhurbaşkanı Erdoğan: Vizyonumuz sağlıklı Türkiye Yüzyılı";
const B04_SUMMARY = "Cumhurbaşkanı Erdoğan, İstanbul'da \"12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni\"nde konuşuyor.";
const B04_MEMBERS = [
  fx("TRT Haber", "trt-haber", "outlet", "2026-10-31T10:26:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde konuşuyor.", "Cumhurbaşkanı Erdoğan: Değerlerimiz yaşatmak üzerine kurulu"),
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-10-31T10:58:30Z", "Cumhurbaşkanı Erdoğan, Rixos Tersane İstanbul'da düzenlenen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde konuşuyor.", "CANLI: Cumhurbaşkanı Erdoğan konuşuyor"),
  fx("Haber Global", "haber-global", "outlet", "2026-10-31T11:24:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, 12. Türk Tıp Dünyası Kurultayı'nda konuşuyor.", "Cumhurbaşkanı Erdoğan'dan açıklamalar"),
  fx("Star", "star", "outlet", "2026-10-31T11:26:00Z", "Cumhurbaşkanı Erdoğan, İstanbul'da \"12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni\"nde konuşuyor.", "Türkiye Yüzyılı için yeni hedef! Cumhurbaşkanı Erdoğan: Sağlıkta da destan yazacağız"),
  fx("Hürriyet", "hurriyet", "outlet", "2026-10-31T11:26:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, Rixos Tersane İstanbul'da düzenlenen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde konuşuyor.", "Cumhurbaşkanı Erdoğan'dan önemli açıklamalar"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-10-31T11:27:07Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, Rixos Tersane İstanbul'da düzenlenen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde önemli açıklamalarda bulunuyor.", "Cumhurbaşkanı Erdoğan konuşuyor"),
  fx("F5 Haber", "f5-haber", "aggregator", "2026-10-31T11:31:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Ödül Töreni’nde yaptığı konuşmada, Türkiye’nin sağlık teknolojileri ve tıbbi cihaz üretiminde attığı adımlara değindi. Erdoğan, yerli üretimin artırılması ve dışa bağımlılığın azaltılmasının önemini vurguladı.", "Cumhurbaşkanı Erdoğan'dan sağlıkta yeni dönem mesajı! Yerli üretim vurgusu"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-10-31T12:05:49Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, Rixos Tersane İstanbul'da gerçekleştirilen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde önemli açıklamalarda bulundu. Erdoğan, sağlık sektöründe devreye alınan yerli üretim modeli sayesinde kritik tıbbi cihaz ve ekipmanların artık Türkiye'de üretildiğini duyurdu.", "Cumhurbaşkanı Erdoğan'dan Sağlık Sektöründe Yerli Üretim Vurgusu"),
  fx("Aydınlık", "aydinlik", "outlet", "2026-10-31T12:16:39Z", "Cumhurbaşkanı Erdoğan, 12. Türk Tıp Dünyası Kurultayı'nda yaptığı konuşmada sağlıkta yerli üretimin stratejik önemine vurgu yaptı. Tıbbi cihazların artık Türkiye'de üretilip ihraç edildiğini belirten Erdoğan, savunma sanayisindeki başarıyı sağlık sektöründe de yakalayacaklarını söyledi.", "Savunma sanayisinden sonra sıra sağlıkta! Cumhurbaşkanı Erdoğan açıkladı"),
  fx("Dijital Gaste", "dijital-gaste", "outlet", "2026-10-31T12:30:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul’da düzenlenen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni’nde, sağlıkta yerli üretimin önemini vurguladı. Tıbbi cihaz ve ekipmanları artık Türkiye’de ürettiklerini belirten Erdoğan, \"Savunma sanayisinde nasıl destan yazdıysak sağlık sektöründe de aynı başarıyı elde edeceğiz.\" dedi.", "Cumhurbaşkanı Erdoğan: \"Sağlıkta zirveye oynamayı sürdüreceğiz\""),
  fx("BHA", "bha", "wire", "2026-10-31T12:33:48Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni’nde yaptığı konuşmada, “Savunma sanayiinde nasıl destan yazdıysak aynı başarıları sağlık sektöründe de elde edeceğiz” dedi.", "Cumhurbaşkanı Erdoğan: Sağlık sektöründe de savunma sanayiindeki başarıları elde edeceğiz"),
];

// 85ef184c: neutral title "Cumhurbaşkanı Erdoğan: İsrail'e iltimas geçiliyor"
const R85_TITLE = "Cumhurbaşkanı Erdoğan: İsrail'e iltimas geçiliyor";
const R85_SUMMARY = "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış Töreni'nde açıklamalarda bulunuyor.";
const R85_MEMBERS = [
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-06T09:53:13Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul Kongre Merkezi'nde, \"TRT World Forum 2026 Resmi Açılış Töreni\"nde konuşuyor.", "CANLI: Cumhurbaşkanı Erdoğan konuşuyor"),
  fx("Star", "star", "outlet", "2026-11-06T12:27:00Z", "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış Töreni'nde açıklamalarda bulunuyor.", "Cumhurbaşkanı Erdoğan'dan reform vurgusu: Dünya sancılı bir dönemden geçiyor"),
  fx("Hürriyet", "hurriyet", "outlet", "2026-11-06T12:28:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul Kongre Merkezi'nde TRT World Forum 2026 etkinliğinde konuştu.", "'İsrail'e iltimas geçiliyor' Cumhurbaşkanı Erdoğan: Uluslararası sistem iflas etti"),
  fx("Türkiye Gazetesi", "turkiye-gazetesi", "outlet", "2026-11-06T12:28:34Z", "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 etkinliğinde açıklamalarda bulunuyor.", "Cumhurbaşkanı Erdoğan'dan önemli açıklamalar"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-06T12:31:54Z", "Cumhurbaşkanı Erdoğan'ın açıklamalarından satır başları şöyle;İki gün boyunca önemli konuların ele alınacağı forumun ülkelerimiz ve tüm insanlık için hayırlara vesile olmasını diliyorum.", "Son dakika... Cumhurbaşkanı Erdoğan: Algı operasyonlarına boyun eğmeyiz"),
  fx("Haber7", "haber7", "outlet", "2026-11-06T12:32:00Z", "Son dakika haberi... Cumhurbaşkanı Erdoğan, İstanbul Kongre Merkezi'nde \"TRT World Forum 2026 Resmi Açılış Töreni\"nde konuşuyor.", "Erdoğan'dan son dakika açıklamalar"),
  fx("Habertürk", "haberturk", "outlet", "2026-11-06T12:32:21Z", "Son dakika... Cumhurbaşkanı Erdoğan, TRT World Forum 2026 etkinliğinde açıklamalarda bulunuyor", "Cumhurbaşkanı Erdoğan'dan açıklamalar"),
  fx("OdaTV", "odatv", "outlet", "2026-11-06T12:42:59Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, TRT World Forum 2026 etkinliğinde sistem eleştirisi yaptı. Dünyanın sancılı bir süreçten geçtiğini vurgulayan Cumhurbaşkanı Erdoğan, \"Eskinin ölmekte olduğu, yeninin ise henüz doğamadığı yapısal bir krizi hep beraber tecrübe ediyoruz\" ifadelerini kullandı.", "TRT World Forum 2026'da Cumhurbaşkanı Erdoğan'dan sistem eleştirisi... \"Eski öldü, yeni henüz doğamadı\""),
  fx("Haber.com", "haber-com", "outlet", "2026-11-06T13:06:55Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul Kongre Merkezi'nde bu yıl onuncusu düzenlenen TRT World Forum 2026'nın açılışında uluslararası kamuoyuna ve küresel karar alıcılara sert eleştiriler yöneltti.", "Cumhurbaşkanı Erdoğan TRT World Forum'da Konuştu: \"Küresel Sistem İflas Bayrağını Çekti, Dünün Reçeteleri Çare Olmuyor\""),
  fx("Dünya", "dunya", "niche", "2026-11-06T13:09:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, TRT World Forum 2026'da konuştu. Cumhurbaşkanı Erdoğan \"Bizim de imzalanmasına katkı verdiğimiz Gazze Barış Anlaşması ne yazık ki uygulanmıyor. Uluslararası ilişkilerin temeli olan 'ahde vefa' ilkesi hayata geçirilemiyor. Bu şekilde hiçbir sorunun çözülemeyeceğini herkes anlamalıdır. Uluslararası sistem iflas etti\" dedi.", "Erdoğan: Uluslararası sistem iflas etti"),
  fx("Yeniçağ", "yenicag", "outlet", "2026-11-06T14:01:16Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul Kongre Merkezi'nde TRT World Forum 2026 etkinliğinde konuştu.", "Cumhurbaşkanı Erdoğan TRT World Forum 2026'da konuştu: Sistem iflas bayrağını çekti"),
];

// dd5535a7: neutral title "Bahçeli ile Kol Kola Yürümüştü: Dervişoğlu'ndan Açıklama"
const DD5_TITLE = "Bahçeli ile Kol Kola Yürümüştü: Dervişoğlu'ndan Açıklama";
const DD5_SUMMARY = "Ankara'da ilk tören Anıtkabir'de yapıldı. Başkan Recep Tayyip Erdoğan'ın liderliğindeki Aslanlı Yol'daki kortejde, TBMM Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Yeni Parti Genel Başkanı...Devamı için tıklayınız";
const DD5_MEMBERS = [
  fx("Yeni Asır", "yeni-asir", "outlet", "2026-10-30T03:50:20Z", "Ankara'da ilk tören Anıtkabir'de yapıldı. Başkan Recep Tayyip Erdoğan'ın liderliğindeki Aslanlı Yol'daki kortejde, TBMM Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Yeni Parti Genel Başkanı...Devamı için tıklayınız", "\"Türkiye Yüzyılı milli davamız\""),
  fx("Milliyet", "milliyet", "outlet", "2026-10-30T04:01:45Z", "Anıtkabir’deki tören, devlet erkanının Aslanlı Yol’da yürüyüşüyle başladı. Cumhurbaşkanı Recep Tayyip Erdoğan’ın başkanlığındaki kortejde, TBMM Başkanı Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Yeni Parti Genel Başkanı Özgür Özel, MHP Genel Başkanı Devlet Bahçeli, CHP Genel Başkanı Kemal Kılıçdaroğlu, İYİ Parti Genel Başkanı Müsavat Dervişoğlu, Cumhurbaşkanlığı Kabinesi üyeleri, yüksek yargı organlarının başkanları, Genelkurmay Başkanı Orgeneral Selçuk Bayraktaroğlu, kuvvet kom...", "Devlet erkanı Anıtkabir’i ziyaret etti | Farklı cephelerde mücadele ediyoruz"),
  fx("Haber7", "haber7", "outlet", "2026-10-30T04:23:00Z", "Anıtkabir'deki 29 Ekim töreni sonrası MHP lider Devlet Bahçeli ile kol kola yürüyen İYİ Parti Genel Başkanı Müsavat Dervişoğlu, siyasetteki kutuplaşmaya değinerek, insani ilişkilerin dahi tartışma konusu haline getirildiğini söyledi.", "Bahçeli'yle kol kola girdi: Parti içinden tepki! Dervişoğlu'ndan açıklama"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-10-30T04:51:31Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, 29 Ekim töreninde MHP lideri Devlet Bahçeli ile kol kola yürümesine partisinden gelen tepkilerin ardından açıklama yaptı. Ortada izaha muhtaç bir durum olmadığını belirten Dervişoğlu, siyasetteki kutuplaşma nedeniyle insani ilişkilerin bile tartışma konusu haline getirildiğini söyledi. Erhan Usta'nın tepkisine ilişkin değerlendirmesini ise ertesi güne bıraktı.", "Anıtkabir'deki olay görüntü sonrası Dervişoğlu'ndan ilk açıklama"),
  fx("Independent Türkçe", "indyturk", "outlet", "2026-10-30T06:06:28Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, 29 Ekim Cumhuriyet Bayramı dolayısıyla Anıtkabir'de düzenlenen törenin ardından MHP Genel Başkanı Devlet Bahçeli'nin koluna girerek merdivenlerden inmesine yönelik tepkilere ilişkin değerlendirmede bulundu. Siyasi kutuplaşma nedeniyle insani ilişkilerin dahi tartışma konusu yapıldığını belirten Dervişoğlu, \"Siyasette sorumlu bir makamdayım diye karakterimi değiştiremem\" dedi.\n\nDervişoğlu'nun, Cumhuriyet'in 103. yıl dönümü dolayısıyla Anıtkabir'de dü...", "Dervişoğlu: Siyasette sorumlu bir makamdayım diye karakterimi değiştiremem"),
  fx("Cumhuriyet", "cumhuriyet", "outlet", "2026-10-30T06:20:00Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, MHP lideri Devlet Bahçeli'nin koluna girdiği anlarla ilgili gelen eleştiriler üzerine \"Bütün bu olup bitenleri anlayışla yaklaşıyorum. Siyasette sorumlu bir makamdayım diye karakterimi değiştiremem\" dedi.", "Müsavat Dervişoğlu'ndan Bahçeli'nin koluna girdiği görüntülere ilişkin açıklama: 'İnsani ilişkiler bile siyasette tartışma konusu yapılabiliyor'"),
  fx("Ekonomim", "ekonomim", "niche", "2026-10-30T06:21:00Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, Anıtkabir’de MHP lideri Devlet Bahçeli’nin koluna girmesine yönelik tepkilere yanıt verdi. Dervişoğlu, siyasette kutuplaşmanın insani ilişkileri de tartışma konusu haline getirdiğini belirterek konuyla ilgili bugün açıklama yapacağını söyledi.", "Müsavat Dervişoğlu'ndan Bahçeli açıklaması: İzaha muhtaç bir durum yok"),
  fx("Elips Haber", "elips-haber", "outlet", "2026-10-30T06:22:00Z", "Anıtkabir'deki 29 Ekim töreni sonrası MHP lider Devlet Bahçeli ile kol kola yürüyen İYİ Parti Genel Başkanı Müsavat Dervişoğlu, siyasetteki kutuplaşmaya değinerek, insani ilişkilerin dahi tartışma konusu haline getirildiğini söyledi.", "Bahçeli’nin koluna giren Dervişoğlu’ndan eleştirilere yanıt!"),
  fx("Haber.com", "haber-com", "outlet", "2026-10-30T07:18:19Z", "İYİ Parti Lideri Müsavat Dervişoğlu, 29 Ekim Anıtkabir töreninde MHP lideri Devlet Bahçeli ile kol kola görüntülenmişti.", "Bahçeli ile Kol Kola Yürümüştü: Dervişoğlu'ndan Açıklama"),
  fx("Gazete Oksijen", "gazete-oksijen", "outlet", "2026-10-30T07:22:00Z", "Antıkabir'de düzenlenen törende MHP lideri Devlet Bahçeli'nin koluna girmesi eleştirilen İyi Parti Genel Başkanı Müsavat Dervişoğlu, konuyu değerlendirdi", "Dervişoğlu'ndan Bahçeli ile olan görüntüsüne dair açıklama: Sorumlu bir makamdayım diye karakterimi değişemem"),
  fx("Evrensel", "evrensel", "outlet", "2026-10-30T08:17:00Z", "İYİP Genel Başkanı Müsavat Dervişoğlu, Anıtkabir'de MHP lideri Devlet Bahçeli'nin koluna girmesine yönelik eleştirilere yanıt verdi. Dervişoğlu, \"Konuyla ilgili yarın bir açıklama yapacağım. Aslında izaha muhtaç bir durum yok ortada\" dedi.", "Bahçeli'yle kol kola yürüyen Dervişoğlu'ndan açıklama: İzaha muhtaç bir durum yok"),
  fx("BirGün", "birgun", "outlet", "2026-10-30T09:22:00Z", "ANıtkabir'de MHP Lideri Bahçeli'nin koluna girdiği için partisinden ve kamuoyundan eleştiri alan İYİ Parti Lideri Müsavat Dervişoğlu \"Bugün olsa yine aynısını yaparım\" dedi.", "İYİ Parti’den tepki gelmişti: Bahçeli'nin koluna girdiği için eleştirilen Müsavat Dervişoğlu'ndan açıklama"),
  fx("Dijital Gaste", "dijital-gaste", "outlet", "2026-10-30T11:04:00Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, MHP lideri Devlet Bahçeli ile Anıtkabir'de kol kola yürüdüğü görüntülere yönelik eleştirilere, “Koluna girdiğim kişi Devlet Bahçeli olduğu için bu tartışmalar yaşanıyor.” sözleriyle yanıt verdi.", "Müsavat Dervişoğlu, Anıtkabir'deki görüntülere ilişkin konuştu: “Söyleyecek lafı olan gitsin, Bahçeli'ye söylesin”"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-10-30T11:22:12Z", "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, Anıtkabir'de MHP lideri Devlet Bahçeli'nin koluna girmesine yönelik eleştirilere net bir yanıt verdi. Davranışının siyasi nezaket çerçevesinde gerçekleştiğini belirten Dervişoğlu, bugün benzer bir durum yaşanması halinde yine aynı hareketi yapacağını vurguladı.", "Müsavat Dervişoğlu'ndan Devlet Bahçeli Açıklaması"),
];

// 181cd879: neutral title "Cumhurbaşkanı Erdoğan'dan 'fon' açıklaması: Hiç ummadığınız insanlar işin içine girmişler"
const K18_TITLE = "Cumhurbaşkanı Erdoğan'dan 'fon' açıklaması: Hiç ummadığınız insanlar işin içine girmişler";
const K18_SUMMARY = "Son  dakika... Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz ver...";
const K18_MEMBERS = [
  fx("Haber7", "haber7", "outlet", "2026-11-05T09:00:00Z", "SON DAKİKA... Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz verilmeyeceğini belirterek, rüşvet, usulsüzlük ve suistimallerin tek tek ortaya çıkarılacağını söyledi.", "SON DAKİKA: Cumhurbaşkanı Erdoğan: Haksız kazanç sağlayan herkes hesabını verecek!"),
  fx("Sözcü", "sozcu", "outlet", "2026-11-05T09:04:56Z", "Son  dakika... Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz ver...", "Cumhurbaşkanı Erdoğan'dan 'fon' açıklaması: Hiç ummadığınız insanlar işin içine girmişler"),
  fx("Onedio", "onedio", "aggregator", "2026-11-05T09:11:07Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Ziyareti Dönüşünde Gazetecilerin sorularını yanıtladı. Erdoğan'a son günlerin gündeminde yer alan 'fon vurgusu'na dair 'Bundan sonra süreç nasıl işleyecek? Son durum nedir?' sorusu yöneltildi.Erdoğan'ın açıklamasından öne çıkan kısımlar aşağıdaki gibidir:'Bu konuda gerekli yol haritasını oluşturduk, gerekli talimatları verdik. Yol haritasına göre her kurum kendi görevini yerine getiriyor. Yani buradan daha önce yaptığım açıklamalarda da söylediği...", "Cumhurbaşkanı Erdoğan'dan 'Fon Vurgunu' Açıklaması: \"Hiç Ummadığınız İnsanlar İşin İçine Girmişler\""),
  fx("Cumhuriyet", "cumhuriyet", "outlet", "2026-11-05T09:18:00Z", "Son dakika... AKP'li Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz verilmeyeceğini belirterek, rüşvet, usulsüzlük ve suistimallerin tek tek ortaya çıkarılacağını söyledi.", "Son Dakika... Erdoğan'dan 'fon vurgunu' açıklaması: 'Hiç ummadığınız insanlar işin içine girmişler'"),
  fx("Elips Haber", "elips-haber", "outlet", "2026-11-05T09:23:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz verilmeyeceğini belirterek, rüşvet, usulsüzlük ve suistimallerin tek tek ortaya çıkarılacağını söyledi.", "Erdoğan'dan fon soruşturmasına ilişkin dikkat çeken açıklama!"),
  fx("Habervakti", "habervakti", "outlet", "2026-11-05T09:41:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasına ilişkin yürütülen süreçte hiçbir şekilde taviz verilmeyeceğini belirterek, rüşvet, usulsüzlük ve suistimallerin tek tek ortaya çıkarılacağını söyledi.", "Erdoğan: Haksız kazanç sağlayan herkes hesabını verecek!"),
  fx("Korkusuz", "korkusuz", "outlet", "2026-11-05T10:01:26Z", "Erdoğan'dan fon açıklaması: Hiç ummadığınız insanlar işin içine girmişler", "Erdoğan'dan fon açıklaması: Hiç ummadığınız insanlar işin içine girmişler"),
  fx("İlke TV", "ilke-tv", "outlet", "2026-11-05T10:53:14Z", "Cumhurbaşkanı Erdoğan, Güney Kore'deki temaslarının ardından uçakta gündeme ilişkin soruları yanıtladı. Meclis'te alt komisyonların kurulmasıyla somut adımların atılmasının beklendiği sürece ilişkin de konuşan Erdoğan, \"Silah bırakmanın tam anlamıyla gerçekleşmesi, tespit ve teyit süreçlerinin tamamlanması ile yeni aşamaya geçeceğiz\" dedi.", "Cumhurbaşkanı Erdoğan’dan ‘fon’ açıklaması: ‘Hiç ummadığınız insanlar işin içine girmişler’"),
  fx("Dokuz8 Haber", "dokuz8-haber", "outlet", "2026-11-05T11:00:50Z", "Cumhurbaşkanı Erdoğan, Güney Kore dönüşü uçakta yaptığı açıklamada fon soruşturmasına ilişkin yargının gereğini yaptığını belirterek, kamu kaynağı kullanılmadan tasfiye sürecinin yürütüldüğünü ve silah bırakmanın teyit edilmesiyle yeni aşamaya geçileceğini söyledi.", "Erdoğan'dan fon açıklaması: Hiç ummadığınız insanlar işin içine girmişler"),
  fx("F5 Haber", "f5-haber", "aggregator", "2026-11-05T11:03:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, fon soruşturmasında hiçbir şekilde taviz verilmeyeceğini açıkladı. Rüşvet, usulsüzlük ve suistimallerin tek tek ortaya çıkarıldığını belirten Erdoğan, \"Hiç ummadığınız insanlar, bu işlerin içerisine girmişler\" dedi.", "Erdoğan'dan fon soruşturmasında çarpıcı sözler: Hiç ummadığınız insanlar işin içinde"),
  fx("10Haber", "on-haber", "outlet", "2026-11-05T13:28:01Z", "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore’ye yaptığı ziyaret sonrası uçakta kendisini izleyen gazetecilerin sorularını yanıtladı. Erdoğan fon soygunuyla ilgili bir soruya “Rüşvet, usulsüzlük, suistimal, bütün bunlar tek tek ortaya çıkartılıyor. Tabii bir gerçek var? Nedir bu gerçek? Bakıyorsunuz hiç ummadığınız insanlar, bu işlerin içerisine girmişler. Yargı bunları tespit ediyor ve gerekeni yapıyor” cevabını verdi. “Terörsüz […]", "Fon soygunu… Erdoğan: Bakıyorsunuz hiç ummadığınız kişiler bu işlere girmişler"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-11-06T01:00:00Z", "Cumhurbaşkanı Erdoğan, fon soruşturmasından taviz verilme-yeceğini söyledi. Rüşvet, usulsüzlük ve suistimalin tek tek ortaya çıkartıldığını belirten Erdoğan, “Tabii bir gerçek var? Nedir bu gerçek? Bakıyorsunuz hiç ummadığınız insanlar, bu işlerin içerisine girmişler. Yargı bunları tespit ediyor ve gerekeni yapıyor” dedi.", "Ummadığımız kişiler bu işe girmiş"),
  fx("Hürriyet", "hurriyet", "outlet", "2026-11-06T04:00:00Z", "Cumhurbaşkanı Tayyip Erdoğan, fon soruşturmasına ilişkin “Rüşvet, usulsüzlük, suiistimal, bütün bunlar tek tek ortaya çıkartılıyor. Tabii bir gerçek var.\u00a0 Bakıyorsunuz hiç ummadığınız insanlar, bu işlerin içerisine girmişler. Yargı bunları tespit ediyor ve gerekeni yapıyor” dedi.", "Erdoğan’dan fon açıklamaları: Tek tek ortaya çıkartılıyor"),
];

// 8e1a8c91: neutral title "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"
const S8E_TITLE = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı";
const S8E_SUMMARY = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.";
const S8E_MEMBERS = [
  fx("Son Dakika", "son-dakika", "aggregator", "2026-11-02T13:54:50Z", "TBMM Başkanı Numan Kurtulmuş, TBMM Genel Sekreterliği görevine Kemal Şamlıoğlu'nu atadı.", "Numan Kurtulmuş, TBMM Genel Sekreterliğine Kemal Şamlıoğlu'nu atadı"),
  fx("Akşam", "aksam", "outlet", "2026-11-02T14:09:00Z", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-02T14:13:06Z", "1978'de Rize'de doğan Şamlıoğlu, Milli Eğitim Bakanlığı Özel Öğretim Kurumları Genel Müdürlüğü, Ankara Hacı Bayram Veli Üniversitesi Genel Sekreterliği, Cumhurbaşkanlığı Eğitim ve Öğretim Politikaları Kurulu Üyeliği ve Milli Eğitim Bakan Yardımcılığı görevlerinde bulundu.\nSamsun Üniversitesinde profesör olarak görev yapan Şamlıoğlu, üst politika belgelerinin hazırlanması, mevzuat çalışmaları, stratejik planlama, bütçe yönetimi ve yasama süreçlerinde sorumluluklar üstlendi.", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"),
  fx("Star", "star", "outlet", "2026-11-02T14:26:00Z", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.", "Kemal Şamlıoğlu, TBMM Genel Sekreterliğine getirildi"),
  fx("BirGün", "birgun", "outlet", "2026-11-02T14:27:00Z", "TBMM'de Genel Sekreterlik görevine Kemal Şamlıoğlu'nun atandığı öğrenildi.", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"),
  fx("Muhalif", "muhalif", "outlet", "2026-11-02T14:28:01Z", "Millî Eğitim Bakan Yardımcılığı ve Cumhurbaşkanlığı Eğitim ve Öğretim Politikaları Kurulu üyeliği görevlerinde bulunan Şamlıoğlu'nun yeni görevi belli oldu.", "TBMM Genel Sekreterliği görevine Prof. Dr. Kemal Şamlıoğlu atandı"),
  fx("Elips Haber", "elips-haber", "outlet", "2026-11-02T14:44:00Z", "Türkiye Büyük Millet Meclisi (TBMM) Genel Sekreterliği görevine Kemal Şamlıoğlu getirildi. Atamanın, TBMM Başkanı Numan Kurtulmuş tarafından yapıldığı öğrenildi.", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"),
  fx("Cumhuriyet", "cumhuriyet", "outlet", "2026-11-02T14:55:00Z", "TBMM Genel Sekreterliği görevine TBMM Başkanı Numan Kurtulmuş tarafından Kemal Şamlıoğlu getirildi.", "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-02T15:04:02Z", "TBMM Başkanı Numan Kurtulmuş, Meclis Genel Sekreterliğine Kemal Şamlıoğlu'nu atadı. 1978'de Rize'de doğan Şamlıoğlu daha önce Milli Eğitim Bakan Yardımcılığı ve Ankara Hacı Bayram Veli Üniversitesi Genel Sekreterliği yaptı. Peki, Kemal Şamlıoğlu kimdir, hangi görevlerde bulundu? Yeni genel sekreter şu an Samsun Üniversitesinde profesör.", "Kemal Şamlıoğlu kimdir? Bakan yardımcılığından TBMM Genel Sekreterliğine"),
  fx("Haber7", "haber7", "outlet", "2026-11-02T16:58:00Z", "TBMM Genel Başkanı Kurtulmuş, Prof. Dr. Kemal Şamlıoğlu'nu TBMM Genel Sekreterliğine atadı.", "Kemal Şamlıoğlu, TBMM Genel Sekreterliğine atandı"),
  fx("BHA", "bha", "wire", "2026-11-02T17:35:28Z", "Türkiye Büyük Millet Meclisi (TBMM) Genel Sekreterliği görevine, eski Millî Eğitim Bakan Yardımcısı Prof. Dr. Kemal Şamlıoğlu getirildi. Rize’nin Ardeşen ilçesinde doğan Şamlıoğlu, eğitim ve kamu yönetimi alanlarında çeşitli üst düzey görevlerde bulundu.", "Prof. Dr. Kemal Şamlıoğlu TBMM Genel Sekreterliğine atandı"),
];

// f1837ee1: neutral title "Bakan Bayraktar yeni yol haritasını duyurdu: 2040'ta enerjide bağımsız olacağız"
const F18_TITLE = "Bakan Bayraktar yeni yol haritasını duyurdu: 2040'ta enerjide bağımsız olacağız";
const F18_SUMMARY = "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, enerjinin yeni yol haritası programında açıklamalarda bulunuyor.";
const F18_MEMBERS = [
  fx("CNN Türk", "cnn-turk", "outlet", "2026-11-05T08:18:04Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, enerjinin yeni yol haritası programında açıklamalarda bulunuyor.", "SON DAKİKA | Bakan Bayraktar: 2040'ta enerjide bağımsız olacağız"),
  fx("Takvim", "takvim", "outlet", "2026-11-05T08:25:54Z", "2017 yılında dönemin Enerji ve Tabii Kaynaklar Bakanı Berat Albayrak tarafından temelleri atılan milli enerji politikasının Milli Enerji 2040 vizyonu açıklanıyor. Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, lansmanda açıklamalarda bulunuyor.", "Bakan Bayraktar Milli Enerji 2040 vizyonunu açıkladı! Sinop ve Trakya'da nükleer için tarih verdi... 500 milyar dolarlık hedef"),
  fx("A Haber", "a-haber", "outlet", "2026-11-05T08:27:21Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 Lansmanı'nda önemli açıklamalarda bulunuyor.Devamı için tıklayınız", "\"Milli Enerji\" de Türkiye'nin yol haritası ne? Bakan Bayraktar açıkladı: 2040'ta enerjide bağımsız olacağız"),
  fx("TRT Haber", "trt-haber", "outlet", "2026-11-05T08:28:00Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, İstanbulda \"Milli Enerji 2040 Lansmanı\"nda konuşuyor.", "Enerji ve Tabii Kaynaklar Bakanı Bayraktar konuşuyor"),
  fx("Haber Global", "haber-global", "outlet", "2026-11-05T08:28:00Z", "Milli Enerji 2040 Lansmanı'nda konuşan Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, enerji dışa bağımlılığının yüzde 68'den yüzde 5'e çekilmesi takdirde cari açığın sıfırlanabileceğini söyledi.", "Bakan Bayraktar: Enerjide dışa bağımlılığı yüzde 50'e çekersek dış açık sıfırlanıyor"),
  fx("Haber7", "haber7", "outlet", "2026-11-05T08:30:00Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 Lansmanı programında açıklamalarda bulunuyor.", "Son Dakika: Bakan Bayraktar Milli Enerji 2040 vizyonunu açıkladı!"),
  fx("Akşam", "aksam", "outlet", "2026-11-05T08:33:00Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 Lansman Programı'nda yaptığı açıklamalarda, \"2040'ta enerjide bağımsız olacağız\" ifadelerini kullandı.", "Bakan Bayraktar yeni yol haritasını duyurdu: 2040'ta enerjide bağımsız olacağız"),
  fx("Ajans Haber", "ajans-haber", "aggregator", "2026-11-05T08:38:06Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 Lansman Programı'nda konuşuyor.", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar konuşuyor"),
  fx("Star", "star", "outlet", "2026-11-05T08:39:00Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, \"Enerjide bağımsız Türkiye olarak öne çıkıyoruz. 2040'ta enerjide bağımsız olacağız. Hedefimiz petrol ve doğal gazda üreten Türkiye.\" dedi.", "Bakan Bayraktar yeni yol haritasını açıkladı: 2040'ta enerjide bağımsız olacağız"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-05T08:40:19Z", "Enerji Bakanı Alparslan Bayraktar: \"Türkiye 2040 itibarıyla 175 bin megavatlık rüzgar ve güneş kurulu gücüne ulaşacak.", "Enerji Bakanı Alparslan Bayraktar: \"Türkiye 2040 itibarıyla 175 bin megavatlık rüzgar ve güneş kurulu gücüne ulaşacak. Yatırım tutarı yaklaşık 100 milyar dolar\""),
  fx("Haber.com", "haber-com", "outlet", "2026-11-05T08:41:15Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 Planı’nda önemli açıklamalarda bulundu.", "Bakan Bayraktar: \"2040’ta Enerjide Bağımsız Olunacak\""),
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-05T08:43:47Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, \"Türkiye 2040 itibarıyla 175 bin megavatlık rüzgar ve güneş kurulu gücüne ulaşacak. Yatırım tutarı yaklaşık 100 milyar dolar.\" dedi.", "Bakan Bayraktar: Türkiye 2040 itibarıyla 175 bin megavatlık rüzgar ve güneş kurulu gücüne ulaşacak"),
  fx("Bloomberg HT", "bloomberg-ht", "niche", "2026-11-05T08:51:04Z", "Milli Enerji 2040 lansmanında konuşan Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, \"2024 yılına kadar 100 milyar dolar yatırımla 175 GW/RES kurulu güç hedefliyoruz\" dedi.", "Bakan Bayraktar: Türkiye artık ekonomisini elektrikleştirecek"),
  fx("Son Dakika", "son-dakika", "aggregator", "2026-11-05T08:52:12Z", "Bakan Bayraktar, enerjinin ekonominin en önemli itici gücü olduğunu belirterek Türkiye ekonomisinin 2040'ta yüzde 36 elektrikleşeceğini söyledi. Bayraktar, 2040'ta 175 GW rüzgar ve güneş enerjisi gücüne ulaşmayı hedeflediklerini ifade etti.", "Bakan Bayraktar, 2040'ta 175 GW rüzgar ve güneş enerjisi hedefini açıkladı"),
  fx("Beyaz Gazete", "beyaz-gazete", "aggregator", "2026-11-05T09:10:34Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, enerjide bağımsızlık hedefini vurgulayarak, yeni dönemde nükleer enerjinin de Türkiye'nin enerji sepetine dahil edilmesi gerektiğini söyledi.", "Enerjide Tam Bağımsızlık Hedefi! Bakan Bayraktar Açıkladı"),
  fx("Ekonomim", "ekonomim", "niche", "2026-11-05T09:41:00Z", "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, Milli Enerji 2040 programı kapsamında Türkiye'nin uzun vadeli enerji stratejisini açıkladı. Yeni yol haritasında enerji arz güvenliğinin güçlendirilmesi, enerji ithalatının azaltılması ve iklim değişikliğiyle mücadele öncelikli başlıklar arasında yer aldı.", "Bakan Bayraktar: Türkiye'yi enerjide bağımsız kılacak adımları atacağız"),
];

// 6ef586c4: neutral title "İstanbul Barosu Başkanı Ümit Kocasakal oldu"
const K6E_TITLE = "İstanbul Barosu Başkanı Ümit Kocasakal oldu";
const K6E_SUMMARY = "İstanbul Barosu başkanlık seçimlerinde adaylar arasında yer alan eski başkan Ümit Kocasakal, yeniden gündeme geldi. Hukukçu ve akademisyen kimliğiyle tanınan Kocasakal'ın yaşamı, mesleki kariyeri ve özel hayatı araştırılıyor. Peki, Ümit Kocasakal kimdir? İstanbul Barosu başkan adayı Ümit Kocasakal nereli, kaç yaşında, evli mi? Detaylar haberimizde.";
const K6E_MEMBERS = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-10-25T15:03:39Z", "İstanbul Barosu başkanlık seçimlerinde adaylar arasında yer alan eski başkan Ümit Kocasakal, yeniden gündeme geldi. Hukukçu ve akademisyen kimliğiyle tanınan Kocasakal'ın yaşamı, mesleki kariyeri ve özel hayatı araştırılıyor. Peki, Ümit Kocasakal kimdir? İstanbul Barosu başkan adayı Ümit Kocasakal nereli, kaç yaşında, evli mi? Detaylar haberimizde.", "Ümit Kocasakal kimdir? İstanbul Barosu yeni başkanı Ümit Kocasakal nereli, kaç yaşında, evli mi?"),
  fx("Ekonomim", "ekonomim", "niche", "2026-10-25T15:11:00Z", "İstanbul Barosu'nun başkanlık seçimlerinde Cumhuriyetçi Güç Birliği'nin adayı olarak yarışan Prof. Dr. Ümit Kocasakal, resmi olmayan sonuçlara göre başkan seçildi. Kocasakal'ın yeniden başkan olmasıyla \"Ümit Kocasakal hangi partili, kaç yaşında, nereli? İstanbul Barosu Başkanı Ümit Kocasakal kimdir?\" sorularının yanıtı merak konusu oldu.", "Ümit Kocasakal hangi partili, kaç yaşında, nereli? İstanbul Barosu Başkanı Ümit Kocasakal kimdir?"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-10-25T15:13:47Z", "İstanbul Barosu başkanlık seçimlerinde yeniden aday olan Ümit Kocasakal'ın yaşamı ve kariyeri merak ediliyor.", "Ümit Kocasakal kimdir? İstanbul Barosu başkan adayı Ümit Kocasakal nereli, kaç yaşında, evli mi?"),
  fx("Onedio", "onedio", "aggregator", "2026-10-25T15:22:14Z", "İstanbul Barosu'nun 128. Olağan Genel Kurulu'nda yapılan başkanlık seçiminin ardından gözler yeni başkana çevrildi. İstanbul Barosu'nun yeni başkanı Ümit Kocasakal kimdir, kaç yaşında ve nereli? Ümit Kocasakal hangi lise ve üniversiteden mezun oldu, akademik kariyeri nerede şekillendi? Daha önce İstanbul Barosu Başkanlığı yaptı mı ve bu seçimde hangi adaylarla yarıştı?", "Ümit Kocasakal Kimdir, Kaç Yaşında ve Nereli? İstanbul Barosu'nun Yeni Başkanı Ümit Kocasakal Kimdir?"),
  fx("Cumhuriyet", "cumhuriyet", "outlet", "2026-10-25T15:24:00Z", "İstanbul Barosu Genel Kurulu’nda Cumhuriyetçi Güç Birliği Grubu’nun adayı Ümit Kocasakal, resmi olmayan sonuçlara göre seçimi kazanarak baronun yeni başkanı oldu. Peki, Ümit Kocasakal kimdir? İstanbul Barosu Başkanı Ümit Kocasakal kaç yaşında, nereli?", "Ümit Kocasakal kimdir? İstanbul Barosu Başkanı Ümit Kocasakal kaç yaşında, nereli?"),
  fx("Karar", "karar", "outlet", "2026-10-25T15:30:48Z", "Tartışmalı geçen İstanbul Barosu 128. Olağan Genel Kurulu’nda resmi olmayan sonuçlara göre, Cumhuriyetçi Güç Birliği Grubu adayı Prof. Dr. Ümit Kocasakal seçimi kazanarak başkan seçildi.", "İstanbul Barosu Başkanı Ümit Kocasakal  oldu"),
  fx("Haber7", "haber7", "outlet", "2026-10-25T15:40:00Z", "Son dakika haberi... İstanbul Barosunun 128'nci Olağan Genel Kurulu'nda resmi olmayan sonuçlara göre başkanlık seçimini Cumhuriyetçi Güç Birliği Grubu adayı Ümit Kocasakal kazandı.", "İstanbul Barosunun yeni başkanı Ümit Kocasakal oldu"),
  fx("Aykırı", "aykiri", "outlet", "2026-10-25T15:49:25Z", "İstanbul Barosu’nun 128. Olağan Genel Kurulu’nda yapılan başkanlık seçimini, eski başkan Prof. Dr. Ümit Kocasakal kazandı.", "İstanbul Barosu'nda \"Türkiyelilik\" dönemi kapandı!"),
];

// 37b2fd17: neutral title "Cevdet Yılmaz'dan emekliye refah düzenlemesiyle ilgili açıklama"
const Y37_TITLE = "Cevdet Yılmaz'dan emekliye refah düzenlemesiyle ilgili açıklama";
const Y37_SUMMARY = "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, NTV'de gündeme ilişkin açıklamalarda bulunuyor.";
const Y37_MEMBERS = [
  fx("Haber7", "haber7", "outlet", "2026-11-06T16:12:00Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, NTV'de gündeme ilişkin açıklamalarda bulunuyor.", "Cevdet Yılmaz'dan emekliye refah düzenlemesiyle ilgili açıklama"),
  fx("GZT", "gzt", "outlet", "2026-11-06T16:18:15Z", "NTV'ye konuşan Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, fon soruşturması kapsamında TMSF bünyesinde açılan \"gönüllü iade\" hesaplarına 31,5 milyar TL'nin iade edildiğini açıkladı.", "Cevdet Yılmaz açıkladı: Fonlarda ara ödemeler için yeni tarih belli oldu"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-11-06T16:18:55Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz gündeme ilişkin açıklamalarda bulunuyor.", "Cumhurbaşkanı Yardımcısı Yılmaz'dan emekli zammı açıklaması: Enflasyonun üzerinde artış olacak"),
  fx("Star", "star", "outlet", "2026-11-06T16:26:00Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz: Serbest fonların içinde hisse senetleri var. Bazı hisse senetleri üzerinden çok ciddi pay oluşturulmuş. Manipüle edilerek fiyatı şişirilmiş. Sanal bir değer gösterilerek kredi oluştururmuş. Bu bir döngü içinde devam etmiş. Bundan çeşitli kişiler ve şirketler haksız kazanç elde etmişler.", "Borsa ve fon vurgunu! Cumhurbaşkanı Yardımcısı Yılmaz: Serbest fonlar üzerinde sanal değer oluşturuldu"),
  fx("Ekonomim", "ekonomim", "niche", "2026-11-06T16:43:00Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, NTV canlı yayınında gündeme ilişkin değerlendirmelerde bulundu. Fon soruşturması, tasfiye süreci, yatırımcılara yapılan ödemeler ve sermaye piyasalarında yeni düzenlemelere ilişkin açıklamalar yaptı. Cevdet Yılmaz, kanuni hazırlıkların yapıldığını söyledi.", "Cevdet Yılmaz canlı yayında açıkladı: Fon tasfiyesinde yeni ödeme için hazırlık yapıyoruz"),
  fx("İstiklal", "istiklal", "outlet", "2026-11-06T16:44:10Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, yatırım fonlarında tespit edilen manipülasyonlara ilişkin yürütülen süreci değerlendirdi. Hukuk dışı kazançlara karşı mücadelenin süreceğini belirten Yılmaz, tasfiyedeki fonlar için yeni ödeme takvimini de açıkladı.", "Cevdet Yılmaz'dan Fon Açıklaması: \"Hukuk ve Ahlak Dışı Kazançlar Var\""),
  fx("Onedio", "onedio", "aggregator", "2026-11-06T16:56:36Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, fon soruşturmasına ilişkin son rakamları paylaştı. Yılmaz, soruşturmada 444 şüpheliden 113'ünün tutuklandığını ve yatırımcılara yeni bir ödeme yapılacağını duyurdu. Enflasyon, asgari ücret ve emekli düzenlemesi de konuşulan başlıklar arasında yer aldı.Kaynak - NTV", "Cevdet Yılmaz'dan Fon Soruşturması, Enflasyon ve Emekli Düzenlemesi Açıklaması"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-06T17:00:46Z", "Milyonlarca emeklinin merakla beklediği 2027 emekli maaşı zammına ilişkin Cumhurbaşkanı Yardımcısı Cevdet Yılmaz'dan önemli açıklamalar geldi. Enflasyon farkı, refah payı ve seyyanen zam seçeneklerinin değerlendirildiği süreçte Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, emeklilere enflasyonun üzerinde artış yapılacağını duyurdu. Düzenlemenin yıl sonuna kadar hazırlanacağını belirten Yılmaz, bütçe görüşmelerinin ardından ve yılbaşından önce kanun çalışmasının TBMM'ye sunulacağını açıkladı.", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz'dan emeklilere zam müjdesi"),
  fx("ABC Haber", "abc-haber", "outlet", "2026-11-06T20:02:00Z", "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, emekli aylıklarına yönelik yeni bir refah düzenlemesi üzerinde çalışıldığını açıkladı. Farklı seçeneklerin değerlendirildiğini belirten Yılmaz, düzenlemenin yılbaşından önce TBMM'ye sunulmasının hedeflendiğini söyledi. NTV yayınında asgari ücret, enflasyon, fon tasfiyesi, yatırımcılara yapılacak ödemeler ve sermaye piyasalarına yönelik yeni kanun hazırlığı h", "Cevdet Yılmaz’dan emeklilere müjde: Yıl sonuna kadar yeni refah düzenlemesi yapılacağını duyurdu"),
  fx("Aykırı", "aykiri", "outlet", "2026-11-06T21:05:06Z", "Emeklilere yönelik refah düzenlemesi hakkında konuşan Cumhurbaşkanı Yardımcısı Yılmaz, farklı alternatiflerin değerlendirildiğini belirterek, Yıl sonuna kadar...", "Hükümetten, emekliye refah düzenlemesiyle ilgili açıklama!"),
];

// 6ce3490f: neutral title "Emine Erdoğan'dan '81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı'na ilişkin paylaşım"
const E6C_SUMMARY = "Cumhurbaşkanı Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşımda bulundu.";
const E6C_MEMBERS = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-07T07:58:08Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşımda bulundu.", "Emine Erdoğan'dan \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşım"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-07T08:01:32Z", "Emine Erdoğan, NSosyal hesabından yaptığı paylaşımda, \"Anadolu'da kadınlar yalnızca sanatlarını değil, birbirlerinin emeğini, sabrını ve zamanını da paylaşarak nice eserler meydana getirmiştir. Bugün bu dayanışma ruhu, sanatkar ve zanaatkar kadınlarımızın hünerli ellerinde yaşamaya devam ediyor.\" ifadesini kullandı.\nPaylaşımda Rami Kütüphanesi'nde gerçekleştirilen programdan görüntüler de yer aldı.\nAnadolu’da kadınlar yalnızca sanatlarını değil; birbirlerinin emeğini, sabrını ve zamanını da p...", "Emine Erdoğan'dan '81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı'na ilişkin paylaşım"),
  fx("Star", "star", "outlet", "2026-11-07T08:06:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, Rami Kütüphanei'nde düzenlenen \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşımda bulundu. Erdoğan, paylaşımında \"Anadolu'da kadınlar yalnızca sanatlarını değil; birbirlerinin emeğini, sabrını ve zamanını da paylaşarak nice eserler meydana getirmiştir. Bugün bu dayanışma ruhu, sanatkâr ve zanaatkâr kadınlarımızın hünerli ellerinde yaşamaya devam ediyor.\" ifadelerini kullandı.", "Rami Kütüphanesi'nde \"Bize Özgü\" sergisi! Emine Erdoğan: Dayanışma ruhu, kadınlarımızın hünerli ellerinde yaşıyor"),
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-07T08:07:21Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşımda bulundu.", "Emine Erdoğan'dan \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşım"),
  fx("Akşam", "aksam", "outlet", "2026-11-07T08:14:00Z", "Emine Erdoğan, \"81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı\"na ilişkin paylaşımda bulundu.", "Emine Erdoğan paylaştı: \"81 İl, 81 Kadın, 81 Hikaye\" sergisi kapılarını açtı"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-11-07T10:49:16Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, Türkiye'nin kültürel zenginliklerini yansıtan 81 İl, 81 Kadın, 81 Hikaye sergisinin açılışına dair önemli bir mesaj yayınladı. Paylaşımında kadın emeğinin ve yöresel değerlerin önemine dikkat çeken Erdoğan, projeyi desteklediğini ifade etti.", "Emine Erdoğan'dan 81 il 81 kadın sergisine destek"),
];

// 31342903: neutral title "Bakan Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü"
const J31_SUMMARY = "Dışişleri Bakanı Hakan Fidan, Ankara'da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi.";
const J31_MEMBERS = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-05T15:59:37Z", "Dışişleri Bakanı Hakan Fidan, Ankara'da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi.", "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü"),
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-05T16:02:48Z", "Dışişleri Bakanı Hakan Fidan, Ankara'da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi.", "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü"),
  fx("Akşam", "aksam", "outlet", "2026-11-05T16:03:00Z", "Dışişleri Bakanı Hakan Fidan, Ankara'da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi.", "Bakan Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü"),
  fx("Sabah", "sabah", "outlet", "2026-11-05T16:11:54Z", "Dışişleri Bakanı Hakan Fidan, Hırvatistan Parlamento Başkanı Gordan Jandroković ile bir araya geldi.Devamı için tıklayınız", "Bakan Fidan, Hırvatistan Parlamento Başkanı ile görüştü!"),
  fx("Star", "star", "outlet", "2026-11-05T16:26:00Z", "Dışişleri Bakanı Hakan Fidan, Hırvatistan Parlamento Başkanı Gordan Jandrokovi ile bir araya geldi.", "Dışişleri Bakanı Fidan Hırvatistan Parlamento Başkanı Gordan Jandrokovi ile görüştü"),
  fx("Ajans Haber", "ajans-haber", "aggregator", "2026-11-05T16:35:00Z", "Dışişleri Bakanı Hakan Fidan, Ankara’da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi.", "Dışişleri Bakanı Hakan Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü"),
];

describe("h95-summaries-1: a live-blog seed is replaced by a clean member from 0.6 up", () => {
  it("b04edded: the live line gives way to a 0.67 member (Aydınlık is one of four), the newest of the tie", () => {
    const seedMember = byName(B04_MEMBERS, "Star");
    expect(seedDisqualified(B04_SUMMARY, shownOf(seedMember), { memberTitle: seedMember.article.title, clusterTitle: B04_TITLE })).toBe("live");
    const aydinlik = byName(B04_MEMBERS, "Aydınlık");
    const dijital = byName(B04_MEMBERS, "Dijital Gaste");
    // Neither reaches 0.75, which is what every replacement needed before; both reach 0.6.
    for (const m of [aydinlik, dijital]) {
      expect(titleAgreement(B04_TITLE, shownOf(m)), m.source.name).toBeCloseTo(2 / 3, 9);
    }
    // The hunter's finding names Aydınlık; Dijital Gaste, published 13 minutes later, scores the same and
    // is clean too, so the unchanged tie rule (the newest wins) picks it. Both are the outlets' own words.
    const res = resolve(B04_TITLE, B04_SUMMARY, B04_MEMBERS);
    expect(["Aydınlık", "Dijital Gaste", "İşçi Haber"]).toContain(res?.source?.name);
    expect(res?.source?.name).toBe("Dijital Gaste");
    expect(res?.text).toBe(shownOf(dijital));
    expect(resolve(B04_TITLE, B04_SUMMARY, B04_MEMBERS.filter((m) => m !== dijital))?.source?.name).toBe("Aydınlık");
  });

  it("f1837ee1: the live line (0.6 against its own title) becomes Ekonomim (0.7)", () => {
    const res = resolve(F18_TITLE, F18_SUMMARY, F18_MEMBERS);
    expect(res?.source?.name).toBe("Ekonomim");
    expect(res?.text).toBe(shownOf(byName(F18_MEMBERS, "Ekonomim")));
  });

  it("85ef184c, the documented residual: no candidate reaches 0.6, so the live line stays (never blank)", () => {
    const seedMember = byName(R85_MEMBERS, "Star");
    const shown = shownOf(seedMember);
    expect(isLiveLine(shown)).toBe(true);
    for (const m of R85_MEMBERS) {
      if (m === seedMember || m.source.kind === "wire" || m.source.kind === "aggregator") continue;
      expect(titleAgreement(R85_TITLE, shownOf(m)) ?? 0, m.source.name).toBeLessThan(AGREEMENT_FORM_DEFECT_MIN);
    }
    const res = resolve(R85_TITLE, R85_SUMMARY, R85_MEMBERS);
    expect(res).toEqual({ text: shown, source: seedMember.source });
  });

  it("459a7b61: Haber7's live line no longer takes the Özet over from the teaser seed", () => {
    const haber7 = byName(H45_MEMBERS, "Haber7");
    expect(summaryDefect(haber7.article.description ?? "", shownOf(haber7))).toBe("live");
    const res = resolve(H45_TITLE, H45_SUMMARY, H45_MEMBERS);
    expect(res).not.toBeNull();
    expect(res?.text).not.toBe(shownOf(haber7));
    expect(res?.source?.name).not.toBe("Haber7");
    expect(isLiveLine(res?.text ?? "")).toBe(false);
  });

  it("a live seed is replaced by a score at the floor (0.6, inclusive) and not below it", () => {
    // Five title stems: cumhu, erdog, azerb, forum, konus.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu";
    const live = fx("Canlı", "canli", "outlet", "2026-11-08T10:00:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan forumunda konuşuyor.", "x");
    const three = fx("Üç", "uc", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan ziyaretinde yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    const two = fx("İki", "iki", "outlet", "2026-11-08T10:06:00Z", "Cumhurbaşkanı Erdoğan, bugün yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    expect(titleAgreement(title, shownOf(three))).toBeCloseTo(0.6, 9);
    expect(titleAgreement(title, shownOf(two))).toBeCloseTo(0.4, 9);
    expect(resolve(title, live.article.description ?? "", [live, three, two])?.source?.name).toBe("Üç");
    expect(resolve(title, live.article.description ?? "", [live, two])?.source?.name).toBe("Canlı");
  });

  it("opinion seeds keep the 0.75 bar: a 0.6 member does not replace a column, a 0.8 one does", () => {
    // Five title stems: cumhu, erdog, azerb, forum, konus.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu";
    const column = fx("Sütun", "sutun", "outlet", "2026-11-08T10:00:00Z", "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu diye yazıyor köşe yazarı.", "x");
    column.article.url = "https://example.com/yazarlar/biri/yazi";
    const three = fx("Üç", "uc", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan ziyaretinde yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    const four = fx("Dört", "dort", "outlet", "2026-11-08T10:06:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan forumunda yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    expect(titleAgreement(title, shownOf(three))).toBeCloseTo(0.6, 9);
    expect(titleAgreement(title, shownOf(four))).toBeCloseTo(0.8, 9);
    const kept = resolve(title, column.article.description ?? "", [column, three]);
    expect(kept?.source?.name).toBe("Sütun");
    expect(kept?.opinion).toBe(true);
    expect(resolve(title, column.article.description ?? "", [column, three, four])?.source?.name).toBe("Dört");
  });

  it("a live line is only replaced when the title is asked for: without agreeWithTitle the seed stays", () => {
    const res = summaryAttribution({ summary: B04_SUMMARY, members: B04_MEMBERS, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Star");
  });
});

describe("h95-summaries-1: a stub that a surname hid, and a teaser seed", () => {
  it("dd5535a7: the cut seed that 'Kurtulmuş' made look complete becomes one of the 0.67 Dervişoğlu leads", () => {
    const seedMember = byName(DD5_MEMBERS, "Yeni Asır");
    const raw = seedMember.article.description ?? "";
    expect(seedDisqualified(raw, tidySummaryText(raw), { memberTitle: seedMember.article.title, clusterTitle: DD5_TITLE })).toBe("stub");
    const res = resolve(DD5_TITLE, DD5_SUMMARY, DD5_MEMBERS);
    expect(["Elips Haber", "Haber7", "Dijital Gaste"]).toContain(res?.source?.name);
    expect(res?.text).toBe(shownOf(byName(DD5_MEMBERS, res?.source?.name ?? "")));
    expect(titleAgreement(DD5_TITLE, res?.text ?? "")).toBeCloseTo(2 / 3, 9);
  });

  it("6ef586c4: the Özet no longer ends in the 'Peki … kimdir?' teaser; the biography seed gives way to a member that says the headline (h122-ozet-2)", () => {
    // h95-summaries-1 kept Haberler.com's text with the teaser cut off. Its ARTICLE is "Ümit Kocasakal kimdir? ...
    // nereli, kaç yaşında, evli mi?" under the headline "... Ümit Kocasakal oldu", so h122-ozet-2 treats the seed as an
    // explainer (the gain is waived, the floor stays 0.75): Cumhuriyet's lead states that he won the election.
    const res = resolve(K6E_TITLE, K6E_SUMMARY, K6E_MEMBERS);
    expect(res?.source?.name).toBe("Cumhuriyet");
    expect(res?.text.endsWith("baronun yeni başkanı oldu.")).toBe(true);
    expect(res?.text).not.toMatch(/Peki|kimdir|evli mi/);
    // Without the headline (rss, digest, cards) the seed stays, and its tail is still cut.
    const withoutTitle = summaryAttribution({ summary: K6E_SUMMARY, members: K6E_MEMBERS, wire: NOT_WIRE });
    expect(withoutTitle?.source?.name).toBe("Haberler.com");
    expect(withoutTitle?.text.endsWith("özel hayatı araştırılıyor.")).toBe(true);
  });

  it("459a7b61: a seed that opens with 'İşte' and has nothing to cut is a teaser", () => {
    const shown = tidySummaryText(H45_SUMMARY);
    expect(shown.startsWith("İşte")).toBe(true);
    expect(seedDisqualified(H45_SUMMARY, shown)).toBe("teaser");
  });
});

describe("h95-summaries-1: an echo of the headline is not an Özet", () => {
  it("181cd879: Korkusuz's description is its own headline, so Hürriyet (0.7) takes the cut stub's place", () => {
    const korkusuz = byName(K18_MEMBERS, "Korkusuz");
    expect(isHeadlineEcho(korkusuz.article.title, shownOf(korkusuz))).toBe(true);
    const res = resolve(K18_TITLE, K18_SUMMARY, K18_MEMBERS);
    expect(res?.source?.name).toBe("Hürriyet");
    expect(res?.text).toBe(shownOf(byName(K18_MEMBERS, "Hürriyet")));
  });

  it("8e1a8c91: an Özet that is the cluster title again gives way to a member that says more", () => {
    const akşam = byName(S8E_MEMBERS, "Akşam");
    expect(shownOf(akşam)).toBe("TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.");
    const res = resolve(S8E_TITLE, S8E_SUMMARY, S8E_MEMBERS);
    expect(res).not.toBeNull();
    expect(res?.source?.name).not.toBe("Akşam");
    expect(isHeadlineEcho(S8E_TITLE, res?.text)).toBe(false);
    expect(res?.text).toBe(shownOf(byName(S8E_MEMBERS, res?.source?.name ?? "")));
  });

  it("with no better member the echo stays (never blank)", () => {
    const only = [byName(S8E_MEMBERS, "Akşam"), byName(S8E_MEMBERS, "Star")];
    const res = resolve(S8E_TITLE, S8E_SUMMARY, only);
    expect(res?.text).toBe("TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.");
    expect(res?.source?.name).toBe("Akşam");
  });

  it("a candidate that echoes the cluster title is never picked, and neither is one that echoes its own headline", () => {
    // Seed 'disagrees' with the title (0.2); every candidate is an echo of something.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda hazırlıkları anlattı";
    const seed = fx("Tohum", "tohum", "outlet", "2026-11-08T10:00:00Z", "Bugün Ankara'da hava parçalı bulutlu ve rüzgarlı geçecek.", "x");
    const ownEcho = fx("Kendi", "kendi", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan Azerbaycan'da forumda hazırlıkları anlattı.", "Cumhurbaşkanı Erdoğan Azerbaycan'da forumda hazırlıkları anlattı");
    const titleEcho = fx("Başlık", "baslik", "outlet", "2026-11-08T10:06:00Z", `${title}.`, "başka bir başlık");
    expect(resolve(title, seed.article.description ?? "", [seed, ownEcho, titleEcho])?.source?.name).toBe("Tohum");
    // The same description under a headline that does not echo it is a candidate.
    const fine = fx("Kendi", "kendi", "outlet", "2026-11-08T10:05:00Z", ownEcho.article.description ?? "", "Forumda önemli açıklamalar");
    expect(resolve(title, seed.article.description ?? "", [seed, fine])?.source?.name).toBe("Kendi");
  });

  it("a member without a title (a lighter projection) is never an echo", () => {
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda hazırlıkları anlattı";
    const seed = fx("Tohum", "tohum", "outlet", "2026-11-08T10:00:00Z", "Bugün Ankara'da hava parçalı bulutlu ve rüzgarlı geçecek.", "x");
    const light = fx("Hafif", "hafif", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan Azerbaycan'da forumda hazırlıkları anlattı.", "x");
    delete (light.article as { title?: string }).title;
    expect(resolve(title, seed.article.description ?? "", [seed, light])?.source?.name).toBe("Hafif");
  });
});

describe("h95-summaries-1: a cut with no ellipsis (37b2fd17)", () => {
  it("the swap pick, ABC Haber's 400-character cut, now ends at '…hedeflendiğini söyledi.'", () => {
    const abc = byName(Y37_MEMBERS, "ABC Haber");
    expect(abc.article.description).toHaveLength(400);
    const res = resolve(Y37_TITLE, Y37_SUMMARY, Y37_MEMBERS);
    expect(res?.source?.name).toBe("ABC Haber");
    expect(res?.text.endsWith("hedeflendiğini söyledi.")).toBe(true);
    expect(res?.text).not.toMatch(/ h$/);
  });
});

describe("h95-summaries-1: negative pins", () => {
  it("a clean seed that scores 0.5 or more is never replaced, whatever the members say", () => {
    // f1837ee1 with Ekonomim's text as the seed: clean, 0.7. Live lines and stubs are around it.
    const ekonomim = byName(F18_MEMBERS, "Ekonomim");
    const res = resolve(F18_TITLE, ekonomim.article.description ?? "", F18_MEMBERS);
    expect(res).toEqual({ text: shownOf(ekonomim), source: ekonomim.source });
    // dd5535a7 with Haber7's text as the seed: clean, 0.67, level with Elips Haber and Dijital Gaste.
    const haber7 = byName(DD5_MEMBERS, "Haber7");
    const res2 = resolve(DD5_TITLE, haber7.article.description ?? "", DD5_MEMBERS);
    expect(res2).toEqual({ text: shownOf(haber7), source: haber7.source });
  });

  it("every cluster of the fixtures yields a non-empty Özet", () => {
    const all: Array<[string, string, ClusterDetailMember[]]> = [
      [H45_TITLE, H45_SUMMARY, H45_MEMBERS],
      [B04_TITLE, B04_SUMMARY, B04_MEMBERS],
      [R85_TITLE, R85_SUMMARY, R85_MEMBERS],
      [DD5_TITLE, DD5_SUMMARY, DD5_MEMBERS],
      [K18_TITLE, K18_SUMMARY, K18_MEMBERS],
      [S8E_TITLE, S8E_SUMMARY, S8E_MEMBERS],
      [F18_TITLE, F18_SUMMARY, F18_MEMBERS],
      [K6E_TITLE, K6E_SUMMARY, K6E_MEMBERS],
      [Y37_TITLE, Y37_SUMMARY, Y37_MEMBERS],
    ];
    for (const [title, summary, members] of all) {
      const res = resolve(title, summary, members);
      expect(res, title).not.toBeNull();
      expect(res?.text.length ?? 0, title).toBeGreaterThan(0);
    }
  });
});

describe("h95-summaries-2: identical text is credited to the wire, then the outlet, then the aggregator", () => {
  // 6ce3490f: Haberler.com 07:58:08 and Anadolu Ajansı 08:07:21 hold the identical description.
  const haberler = byName(E6C_MEMBERS, "Haberler.com");
  const aa = byName(E6C_MEMBERS, "Anadolu Ajansı");

  it("the fixtures are what the cases below assume", () => {
    expect(haberler.source.kind).toBe("aggregator");
    expect(aa.source.kind).toBe("wire");
    expect(haberler.article.description).toBe(aa.article.description);
    expect(new Date(haberler.article.published_at).getTime()).toBeLessThan(new Date(aa.article.published_at).getTime());
  });

  it("(a) 6ce3490f: Haberler.com stamped earlier, yet the attribution source is Anadolu Ajansı", () => {
    const res = summaryAttribution({ summary: E6C_SUMMARY, members: E6C_MEMBERS, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Anadolu Ajansı");
    expect(res?.text).toBe(shownOf(aa));
    expect(summaryLabel(res!)).toBe("Özet — Anadolu Ajansı");
    expect(findSeedMember(E6C_MEMBERS, E6C_SUMMARY)).toBe(aa);
  });

  it("(a) 31342903: the same credit, in the other live cluster the hunter named", () => {
    const res = summaryAttribution({ summary: J31_SUMMARY, members: J31_MEMBERS, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Anadolu Ajansı");
  });

  it("(a) the text shown does not change, only whose it is", () => {
    const res = summaryAttribution({ summary: E6C_SUMMARY, members: E6C_MEMBERS, wire: NOT_WIRE });
    expect(res?.text).toBe(shownOf(haberler));
  });

  it("(b) BL-13: Anadolu Ajansı has excerpt_allowed = false, so Haberler.com is credited", () => {
    const blocked = E6C_MEMBERS.map((m) => (m === aa ? { ...m, source: { ...m.source, excerpt_allowed: false } } : m));
    const res = summaryAttribution({ summary: E6C_SUMMARY, members: blocked, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Haberler.com");
    expect(findSeedMember(blocked, E6C_SUMMARY)?.source.name).toBe("Haberler.com");
  });

  it("(b) BL-13: every member holding the text is rights-blocked, so the Özet is hidden as before", () => {
    const blocked = E6C_MEMBERS.map((m) =>
      m === aa || m === haberler ? { ...m, source: { ...m.source, excerpt_allowed: false } } : m,
    );
    expect(summaryAttribution({ summary: E6C_SUMMARY, members: blocked, wire: NOT_WIRE })).toBeNull();
  });

  it("(c) two outlets with the identical text: the earliest wins, as before", () => {
    const text = "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı ile Ankara'da bir araya geldi.";
    const late = fx("Geç", "gec", "outlet", "2026-11-08T10:10:00Z", text, "x");
    const early = fx("Erken", "erken", "outlet", "2026-11-08T10:00:00Z", text, "x");
    expect(summaryAttribution({ summary: text, members: [late, early], wire: NOT_WIRE })?.source?.name).toBe("Erken");
    expect(findSeedMember([late, early], text)).toBe(early);
  });

  it("(c) an outlet and a niche source rank alike: the earliest wins, and a missing kind reads as an outlet", () => {
    const text = "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı ile Ankara'da bir araya geldi.";
    const niche = fx("Niş", "nis", "niche", "2026-11-08T10:00:00Z", text, "x");
    const outlet = fx("Dış", "dis", "outlet", "2026-11-08T10:05:00Z", text, "x");
    const bare = fx("Yalın", "yalin", "outlet", "2026-11-08T09:55:00Z", text, "x");
    delete (bare.source as { kind?: SourceKind }).kind;
    expect(findSeedMember([outlet, niche], text)).toBe(niche);
    expect(findSeedMember([outlet, niche, bare], text)).toBe(bare);
  });

  it("an outlet is credited before an earlier aggregator, and the wire before an earlier outlet", () => {
    const text = "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı ile Ankara'da bir araya geldi.";
    const aggregator = fx("Toplayıcı", "toplayici", "aggregator", "2026-11-08T10:00:00Z", text, "x");
    const outlet = fx("Dış", "dis", "outlet", "2026-11-08T10:05:00Z", text, "x");
    const wire = fx("Ajans", "ajans", "wire", "2026-11-08T10:10:00Z", text, "x");
    expect(findSeedMember([aggregator, outlet], text)).toBe(outlet);
    expect(findSeedMember([aggregator, outlet, wire], text)).toBe(wire);
    // Among the wires the earliest wins, among the aggregators too.
    const wire2 = fx("Ajans 2", "ajans-2", "wire", "2026-11-08T10:07:00Z", text, "x");
    expect(findSeedMember([wire, wire2], text)).toBe(wire2);
    const aggregator2 = fx("Toplayıcı 2", "toplayici-2", "aggregator", "2026-11-08T09:00:00Z", text, "x");
    expect(findSeedMember([aggregator, aggregator2], text)).toBe(aggregator2);
  });

  it("the opinion flag follows the member that is credited", () => {
    const text = "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı ile Ankara'da bir araya geldi.";
    const column = fx("Köşe", "kose", "outlet", "2026-11-08T10:00:00Z", text, "x");
    column.article.url = "https://example.com/yazarlar/biri/yazi";
    const wire = fx("Ajans", "ajans", "wire", "2026-11-08T10:10:00Z", text, "x");
    const res = summaryAttribution({ summary: text, members: [column, wire], wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Ajans");
    expect(res?.opinion).toBeUndefined();
  });

  describe("(d) the wire-majority hide is still decided on the earliest-published match, today's seed", () => {
    const text = "Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı ile Ankara'da bir araya geldi.";
    const WIRE = { isWireRedistribution: true };
    const other = (n: number): ClusterDetailMember =>
      fx(`Başka ${n}`, `baska-${n}`, "outlet", `2026-11-08T11:0${n}:00Z`, "Farklı bir metin.", "x");
    const withHash = (m: ClusterDetailMember, hash: string): ClusterDetailMember => ({ ...m, article: { ...m.article, content_hash: hash } });

    it("the earliest match carries the majority hash: hidden, although the credited wire does not", () => {
      const early = withHash(fx("Toplayıcı", "toplayici", "aggregator", "2026-11-08T10:00:00Z", text, "x"), "MAJ");
      const aa = withHash(fx("Ajans", "ajans", "wire", "2026-11-08T10:10:00Z", text, "x"), "OTHER");
      const members = [early, aa, withHash(other(1), "MAJ"), withHash(other(2), "MAJ")];
      expect(summaryAttribution({ summary: text, members, wire: WIRE })).toBeNull();
    });

    it("the earliest match is not in the majority: shown, and credited to the wire even though its hash is", () => {
      const early = withHash(fx("Toplayıcı", "toplayici", "aggregator", "2026-11-08T10:00:00Z", text, "x"), "SOLO");
      const aa = withHash(fx("Ajans", "ajans", "wire", "2026-11-08T10:10:00Z", text, "x"), "MAJ");
      const members = [early, aa, withHash(other(1), "MAJ"), withHash(other(2), "MAJ")];
      const res = summaryAttribution({ summary: text, members, wire: WIRE });
      expect(res?.source?.name).toBe("Ajans");
      expect(res?.text).toBe(text);
    });

    it("members stamped at the same instant: the seed is the first in the members' order, as before the credit order existed", () => {
      const at = "2026-11-08T10:00:00Z";
      const agg = withHash(fx("Toplayıcı", "toplayici", "aggregator", at, text, "x"), "MAJ");
      const aa = withHash(fx("Ajans", "ajans", "wire", at, text, "x"), "OTHER");
      const rest = [withHash(other(1), "MAJ"), withHash(other(2), "MAJ")];
      // The aggregator comes first in the list, so it is today's seed: its hash is the majority, so the text is hidden.
      expect(summaryAttribution({ summary: text, members: [agg, aa, ...rest], wire: WIRE })).toBeNull();
      // The wire comes first, so it is the seed: its hash is not the majority, so the text is shown, credited to the wire.
      const res = summaryAttribution({ summary: text, members: [aa, agg, ...rest], wire: WIRE });
      expect(res?.source?.name).toBe("Ajans");
    });

    it("without a wire redistribution nothing is hidden, as before", () => {
      const early = withHash(fx("Toplayıcı", "toplayici", "aggregator", "2026-11-08T10:00:00Z", text, "x"), "MAJ");
      const aa = withHash(fx("Ajans", "ajans", "wire", "2026-11-08T10:10:00Z", text, "x"), "MAJ");
      expect(summaryAttribution({ summary: text, members: [early, aa], wire: NOT_WIRE })?.source?.name).toBe("Ajans");
    });
  });

  describe("(e) the title-agreement choice is unchanged", () => {
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda hazırlıkları anlattı";
    const seedText = "Bugün Ankara'da hava parçalı bulutlu ve rüzgarlı geçecek.";
    const good = "Cumhurbaşkanı Erdoğan, Azerbaycan'daki forumda hazırlıkları anlattı ve bilgi verdi.";

    it("wire and aggregator candidates are never picked", () => {
      const seed = fx("Tohum", "tohum", "outlet", "2026-11-08T10:00:00Z", seedText, "x");
      const aa = fx("Ajans", "ajans", "wire", "2026-11-08T10:01:00Z", good, "y");
      const agg = fx("Toplayıcı", "toplayici", "aggregator", "2026-11-08T10:02:00Z", `${good} Ayrıntılar sürüyor.`, "z");
      expect(resolve(title, seedText, [seed, aa, agg])?.source?.name).toBe("Tohum");
    });

    it("an outlet's text that an agency also holds is the agency's, so it is not picked either", () => {
      const seed = fx("Tohum", "tohum", "outlet", "2026-11-08T10:00:00Z", seedText, "x");
      const aa = fx("Ajans", "ajans", "wire", "2026-11-08T10:01:00Z", good, "y");
      const copy = fx("Kopya", "kopya", "outlet", "2026-11-08T10:10:00Z", good, "y1");
      expect(resolve(title, seedText, [seed, aa, copy])?.source?.name).toBe("Tohum");
    });

    it("identical texts among the outlets are credited to the earliest", () => {
      const seed = fx("Tohum", "tohum", "outlet", "2026-11-08T10:00:00Z", seedText, "x");
      const late = fx("Geç", "gec", "outlet", "2026-11-08T10:20:00Z", good, "y1");
      const early = fx("Erken", "erken", "outlet", "2026-11-08T10:10:00Z", good, "y2");
      expect(resolve(title, seedText, [seed, late, early])?.source?.name).toBe("Erken");
    });
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-1 (hunt 122, 2026-11-11): the Özet and the meta description of b8e7cc75 and 710ef4bb
// were Independent Türkçe's CMS field dump ("...copyright Independentturkish:"). The members are
// the real outlet texts of the live clusters (dumped read-only 2026-11-11), trimmed to the
// members each case needs; the stored summary is the seed's description.
// ---------------------------------------------------------------------------

const CMS_B8_TITLE = "MHP lideri Bahçeli’den 10 Kasım mesajı";
const CMS_B8_MEMBERS = [
  fx("Türkiye Gazetesi", "turkiye-gazetesi", "outlet", "2026-11-09T14:40:03Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün vefatının 88'inci yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ün fikirlerinin çağın gerçekleriyle geliştirilmesi ve Cumhuriyet mirasına sahip çıkılması gerektiğini belirtti.", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-09T14:43:41Z", "Milliyetçi Hareket Partisi Genel Başkanı Devlet Bahçeli’nin, \"Gazi Mustafa Kemal Atatürk’ün 88. Vefat Yıldönümü\" münasebetiyle yapmış olduğu yazılı basın açıklaması şöyle;\n\n\"ATATÜRK’Ü ANMA GÜNÜ, DEVLETİMİZ ADINA, MİLLETİMİZ NAMINA ÇOK KIYMETLİ\" \n\"Türkiye Cumhuriyeti devletinin kurucusu, istiklal mücadelemizin lideri, ilk Cumhurbaşkanımız Gazi Mustafa Kemal Atatürk’ü ebediyete irtihalinin 88. senesinde hürmet, rahmet ve minnetle anıyoruz. Türkiye Cumhuriyeti Devleti’nin kurucusu Gazi Mustafa K...", "Son dakika... Bahçeli'den 'Gazi Mustafa Kemal Atatürk’ün 88. vefat yıl dönümü' mesajı"),
  fx("Hürriyet", "hurriyet", "outlet", "2026-11-09T14:45:00Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün vefatının 88. yıl dönümü dolayısıyla mesajı yayımladı.", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  fx("Haber7", "haber7", "outlet", "2026-11-09T14:46:00Z", "Bahçeli, \"Aramızdan ayrılışının 88'inci yıl dönümünde Gazi Mustafa Kemal Atatürk’ü, Milli Mücadele kahramanlarıyla birlikte aziz şehitlerimizi saygı ve şükran hislerimle anıyor, hepsine Cenab-ı Allah’tan rahmetler niyaz ediyorum.\" dedi.", "Bahçeli'den 10 Kasım mesajı"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-09T14:49:07Z", "MHP Genel Başkanı Devlet Bahçeli, Atatürk'ün 88. vefat yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ü anlamanın kurucu felsefesine, devlet aklına ve temel ilkelerine sahip çıkmaktan geçtiğini belirterek, Cumhuriyet'in sonsuza kadar yaşatılması gerektiğini vurguladı.", "MHP Genel Başkanı Bahçeli: Atatürk'ü anlamanın yolu eserine ve fikirlerine sahip çıkmaktır"),
  fx("Yeniçağ", "yenicag", "outlet", "2026-11-09T15:00:18Z", "MHP Genel Başkanı Devlet Bahçeli, 10 Kasım dolayısıyla Atatürk’ü anma mesajı yayımladı. Atatürk’ü 88. ölüm yıl dönümünde anan Bahçeli, “Atatürk’ü yaşatmanın doğru yolu, eserine sahip çıkmak ve onun fikirlerini çağın gerçekleriyle yorumlayarak geliştirmekle imkana kavuşur” dedi.", "Devlet Bahçeli’den 10 Kasım’da Atatürk mesajı: “Fikirlerini çağın gerçekleriyle geliştirmeliyiz”"),
  fx("A Haber", "a-haber", "outlet", "2026-11-09T15:04:23Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün ebediyete irtihalinin 88. yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ü anmanın yanı sıra onun fikirlerini yaşatmanın önemine...Devamı için tıklayınız", "MHP lideri Bahçeli'den Atatürk'ün 88. yıl dönümünde anma mesajı"),
  fx("Posta", "posta", "outlet", "2026-11-09T15:08:45Z", "MHP lideri Bahçeli, 10 Kasım dolayısıyla yayımladığı mesajında şu ifadelere yer verdi:\nTürkiye Cumhuriyeti devletinin kurucusu, istiklal mücadelemizin lideri, ilk Cumhurbaşkanımız Gazi Mustafa Kemal Atatürk’ü ebediyete irtihalinin 88. senesinde hürmet, rahmet ve minnetle anıyoruz.\nTürkiye Cumhuriyeti Devleti’nin kurucusu Gazi Mustafa Kemal Atatürk’ün ebediyete irtihalinin 88. Yıldönümü, Atatürk’ü anma günü, hiç kuşkusuz devletimiz adına, milletimiz namına çok kıymetli ve çok değerlidir. Ancak...", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  fx("Sabah", "sabah", "outlet", "2026-11-09T15:09:32Z", "MHP Genel Başkanı Devlet Bahçeli, Atatürk’ü vefatının 88’nci yıl dönümünde andı. Bahçeli paylaşımında, “Milli Mücadele kahramanlarıyla birlikte aziz şehitlerimizi saygı ve şükran hislerimle anıyor, hepsine...Devamı için tıklayınız", "MHP lideri Bahçeli’den 10 Kasım paylaşımı!"),
  fx("TRT Haber", "trt-haber", "outlet", "2026-11-09T15:22:00Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün ebediyete intikalinin 88. yılı vesilesiyle yayımladığı mesajda, \"Atatürke sevgi, saygı ve büyük bir duyguyla bağlı olan kuşaklara düşen görev onu anarken anlayıp geriye bıraktığı bu büyük mirası sonsuza kadar yaşatmaktır\" ifadelerini kullandı.", "MHP Genel Başkanı Bahçeli'den 10 Kasım mesajı"),
  fx("Independent Türkçe", "indyturk", "outlet", "2026-11-09T15:32:08Z", "MHP Genel Başkanı Devlet Bahçeli10 KASIMMHP Genel Başkanı Devlet Bahçeli, 10 Kasım dolayısıyla yayımladığı mesajda Gazi Mustafa Kemal Atatürk'ü rahmet ve minnetle andıPazartesi, Kasım 9, 2026 - 18:30Main image: Type: newsSEO Title: Bahçeli'den 10 Kasım mesajı: Atatürk'ü anlamanın en sağlıklı yolu temel ilkelerini faaliyetlerimizin merkezine koymaktırcopyright Independentturkish:", "Bahçeli'den 10 Kasım mesajı: Atatürk'ü anlamanın en sağlıklı yolu temel ilkelerini faaliyetlerimizin merkezine koymaktır"),
];
const CMS_B8_SUMMARY = byName(CMS_B8_MEMBERS, "Milliyet").article.description ?? "";

const CMS_AYM_TITLE = "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir";
const CMS_AYM_MEMBERS = [
  fx("Dokuz8 Haber", "dokuz8-haber", "outlet", "2026-11-09T17:55:00Z", "Anayasa Mahkemesi Başkanı Kadir Özkaya, anayasanın devletin işleyişini ve bireylerin hak ve özgürlüklerini güvence altına alan temel hukuk metni olduğunu vurguladı.", "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir"),
  fx("Independent Türkçe", "indyturk", "outlet", "2026-11-09T18:38:43Z", "AYM Başkanı Kadir ÖzkayaAYM Başkanı Kadir Özkaya, anayasanın hak ve özgürlükleri güvence altına alan temel hukuk metni olduğunu belirterek, “Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir” dediPazartesi, Kasım 9, 2026 - 21:30Main image: HaberType: newsSEO Title: AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidircopyright Independentturkish:", "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir"),
];
const CMS_AYM_SUMMARY = byName(CMS_AYM_MEMBERS, "Dokuz8 Haber").article.description ?? "";

describe("h122-ozet-1: Independent Türkçe's CMS dump is neither the Özet nor the meta description", () => {
  it("b8e7cc75: the Özet is Yeniçağ's lead, not the dump that tied it on the headline and was newer", () => {
    const res = resolve(CMS_B8_TITLE, CMS_B8_SUMMARY, CMS_B8_MEMBERS);
    expect(res?.source?.name).toBe("Yeniçağ");
    expect(res?.text).toBe(shownOf(byName(CMS_B8_MEMBERS, "Yeniçağ")));
    expect(res?.text).not.toMatch(/SEO Title|Main image|Independentturkish/);
  });

  it("710ef4bb: the Özet stays Dokuz8 Haber's sentence, not the 1.00 dump", () => {
    const res = resolve(CMS_AYM_TITLE, CMS_AYM_SUMMARY, CMS_AYM_MEMBERS);
    expect(res?.source?.name).toBe("Dokuz8 Haber");
    expect(res?.text).toBe(shownOf(byName(CMS_AYM_MEMBERS, "Dokuz8 Haber")));
    expect(res?.text).not.toContain("SEO Title");
  });

  it("the meta description carries the same text and no CMS field", () => {
    for (const [title, summary, members] of [
      [CMS_B8_TITLE, CMS_B8_SUMMARY, CMS_B8_MEMBERS],
      [CMS_AYM_TITLE, CMS_AYM_SUMMARY, CMS_AYM_MEMBERS],
    ] as const) {
      const res = resolve(title, summary, members as ClusterDetailMember[]);
      const meta = describeForMeta({ count: members.length, attribution: res, title });
      expect(meta).toContain(res?.source?.name ?? "yok");
      expect(meta).not.toMatch(/SEO Title|Main image|Independentturkish/);
    }
  });

  it("a cluster whose only member is the dump still shows the lead, with no CMS field (never blank)", () => {
    const dumped = byName(CMS_AYM_MEMBERS, "Independent Türkçe");
    const res = resolve(CMS_AYM_TITLE, dumped.article.description ?? "", [dumped]);
    expect(res?.text).toBe(
      "AYM Başkanı Kadir Özkaya, anayasanın hak ve özgürlükleri güvence altına alan temel hukuk metni olduğunu belirterek, “Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir” dedi.",
    );
    expect(res?.source?.name).toBe("Independent Türkçe");
  });

  it("without agreeWithTitle (rss, digest, cards) the seed is shown as before, tidied", () => {
    const res = summaryAttribution({ summary: CMS_B8_SUMMARY, members: CMS_B8_MEMBERS, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Milliyet");
  });

  it("the dump is a 'cms' seed and a 'cms' candidate for the two readers of the Özet", () => {
    const dumped = byName(CMS_B8_MEMBERS, "Independent Türkçe");
    const raw = dumped.article.description ?? "";
    expect(summaryDefect(raw, shownOf(dumped))).toBe("cms");
    expect(seedDisqualified(raw, shownOf(dumped))).toBe("cms");
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-2 (hunt 122, 2026-11-11): the Özet of 72abfb9f, c859c91b and 4e0c0003 was one or two
// bare, speaker-less quotations (Haberler.com copies a wire's quote bullets), and the Özet of
// 777ea7c5 was a biography ("Yonca Verdioğlu Şık kimdir?") under a headline of a detention. The
// members are the real outlet texts of the live clusters (dumped read-only 2026-11-11).
// ---------------------------------------------------------------------------

const QO_SINIRLIOGLU_TITLE = "Türkiye'nin BM Genel Sekreter adayı Sinirlioğlu: Diyalog taviz değil sorumluluktur";
const QO_SINIRLIOGLU = [
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-06T21:39:49Z", "Türkiye’nin Birleşmiş Milletler (BM) Genel Sekreter adayı Feridun Sinirlioğlu, \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım.\" dedi.", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu, \"İnteraktif Diyalog Başlangıcı\" toplantısında hedeflerini açıkladı"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-06T21:42:20Z", "- \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım\"\n\"40 yıllık diplomatik kariyerimde öğrendiğim bir ders varsa o da şudur: Diyalog, her zaman mümkündür. Bunun için yalnızca bir platforma ihtiyaç vardır. BM ise bu platformların en önemlisi\"", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu, \"İnteraktif Diyalog Başlangıcı\" toplantısında hedeflerini açıkladı:"),
  fx("Star", "star", "outlet", "2026-11-06T21:48:00Z", "Türkiye'nin BM Genel Sekreter adayı Feridun Sinirlioğlu, New York'taki BM Genel Merkezi'nde vizyonunu açıkladı. 40 yıllık diplomatik tecrübesine dikkat çekerek etkili arabuluculuk ve sessiz diplomasinin önemini vurgulayan Sinirlioğlu, kriz anlarında taraflarla temas kurmanın taviz değil, barış için bir sorumluluk olduğunu ifade etti.", "Türkiye'nin BM Genel Sekreter adayı Sinirlioğlu: Diyalog taviz değil sorumluluktur"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-11-06T21:52:59Z", "Türkiye'nin Birleşmiş Milletler Genel Sekreter adayı Feridun Sinirlioğlu, katıldığı interaktif diyalog toplantısında adaylık hedeflerini kamuoyu ile paylaştı. Sinirlioğlu, BM'nin yapısının kusursuz olmadığını ancak küresel sistem için vazgeçilmez bir öneme sahip olduğunu vurguladı.", "Feridun sinirlioğlu BM genel sekreterliği için vizyonunu açıkladı"),
  fx("CGTN Türk", "cgtn-turk", "outlet", "2026-11-06T22:18:00Z", "Türkiye’nin Birleşmiş Milletler (BM) Genel Sekreter adayı Feridun Sinirlioğlu, \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım.\" dedi.", "Feridun Sinirlioğlu: BM Genel Sekreterliğine adayım çünkü..."),
  fx("Milliyet", "milliyet", "outlet", "2026-11-06T22:58:45Z", "Eski Dışişleri Bakanı ve halen Avrupa Güvenlik ve İşbirliği Teşkilatı (AGİT) Genel Sekreterliği görevini yürüten Sinirlioğlu, BM Genel Merkezi’nde düzenlenen \"İnteraktif Diyalog Başlangıcı\" toplantısında yaptığı konuşmada, BM Genel Sekreteri seçilmesi halinde izleyeceği politikaları ve öncelik vereceği alanları anlattı.\nSinirlioğlu, BM Şartı'na bağlı kalmanın idealizm meselesi olmadığını ve devletler arasındaki anlaşmazlıkları çözmenin yegane yolu olduğunu vurguladı.\nBM Şartı'nın, uluslararas...", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu hedeflerini açıkladı"),
];
const QO_KACIR_TITLE = "Bakan Kacır, Seul'de Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi";
const QO_KACIR = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-04T17:05:16Z", "- \"Ülkemizin yatırım, üretim ve teknoloji alanlarındaki potansiyelini küresel ölçekte daha ileriye taşımak için uluslararası işbirliklerini artırmaya devam edeceğiz\"", "Bakan Kacır, Seul'de Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi:"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-04T17:45:37Z", "Kacır, sanal medya hesabından hesabından, görüşmeye ilişkin paylaşım yaptı. Cumhurbaşkanımız Erdoğan'ın başkanlığında, Güney Kore'nin başkenti Seul'de teknoloji, otomotiv, elektronik, biyoteknoloji, kimya ve enerji gibi stratejik sektörlerde faaliyet gösteren şirketlerin üst düzey yöneticileriyle bir araya geldiklerini aktaran Kacır, \"⁠LG Electronics Üst Yöneticisi (CEO) Lyu Jae-cheol, ⁠Celltrion CEO'su Seo Jin-seok, ⁠SK Chemicals ve SK Plasma CEO'su Jaehyun Ahn, ⁠Hyundai Motor Group CEO'su C...", "Seul'de stratejik zirve! Bakan Kacır, Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi"),
  fx("Haber7", "haber7", "outlet", "2026-11-04T19:16:00Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, Seul’de Samsung, Hyundai, LG ve SK Chemicals gibi şirketlerin üst düzey yöneticileriyle Türkiye’deki yatırım ve iş birliği fırsatlarını görüştü.", "Bakan Kacır, Güney Koreli teknoloji devleriyle bir araya geldi"),
  fx("Muhalif", "muhalif", "outlet", "2026-11-04T19:28:33Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, Cumhurbaşkanı Erdoğan'ın Seul temasları kapsamında Güney Koreli dev şirketlerin CEO'larıyla bir araya gelerek...", "Seul'de dev zirve: Bakan Kacır küresel teknoloji devleriyle masaya oturdu"),
  fx("Posta", "posta", "outlet", "2026-11-04T22:14:18Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, sanal medya hesabından yaptığı açıklamada şu ifadeleri kullandı:\n\"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın başkanlığında, Güney Kore'nin başkenti Seul'de teknoloji, otomotiv, elektronik, biyoteknoloji, kimya ve enerji gibi stratejik sektörlerde faaliyet gösteren şirketlerin üst düzey yöneticileriyle bir araya geldik. LG Electronics Üst Yöneticisi (CEO) Lyu Jae-cheol, Celltrion CEO'su Seo Jin-seok, SK Chemicals ve SK Plasma CEO'su Jaehyun Ah...", "Bakan Kacır, Cumhurbaşkanı Erdoğan'ın başkanlığında Güney Koreli teknoloji devleriyle bir araya geldi"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-11-05T01:00:00Z", "Cumhurbaşkanı Erdoğan, Güney Kore ziyaretinde teknoloji, elektronik, biyoteknoloji ve kimya alanlarında faaliyet gösteren şirketlerin üst düzey yöneticileriyle görüştü. Görüşmelerde LG Electronics CEO’su Lyu Jae-cheol, Samsung CEO’su Roh Tae-moon ve Hyundai Motor Group CEO’su Chung Euisun de yer aldı.", "Güney Kore’de teknoloji buluşması"),
];
const QO_ALABED_TITLE = "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı";
const QO_ALABED = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-06T15:21:10Z", "- \"Suriye'deki okullar halen yıkık durumda; geleceğimizi yeniden inşa edebilmemiz için bu okulların onarılmasına yardım etmeliyiz\"\n\"Benim için Cumhurbaşkanı Erdoğan büyük bir rol model ve gelecekte onun gibi büyük bir lider olmayı diliyorum\"", "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı:"),
  fx("Anadolu Ajansı", "anadolu-ajansi", "wire", "2026-11-06T15:27:43Z", "Cumhurbaşkanı Erdoğan'a savaştan etkilenen çocukları temsil eden kelebek figürünü takdim eden Suriyeli Alabed, Erdoğan'la 10 yıl sonra bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek \"Kendisi, benim için büyük bir rol model\" dedi.", "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı"),
  fx("Star", "star", "outlet", "2026-11-06T15:44:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim eden Suriyeli Bana Alabed, Cumhurbaşkanı Erdoğan'la 10 yıl sonra yeniden bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek, \"Benim için Cumhurbaşkanı Erdoğan büyük bir rol model ve gelecekte onun gibi büyük bir lider olmayı diliyorum.\" dedi.", "Halep'in sesi Alabed: Cumhurbaşkanı Erdoğan gibi bir lider olmak istiyorum"),
  fx("Akşam", "aksam", "outlet", "2026-11-06T15:51:00Z", "Suriyeli aktivist Bana Alabed, Başkan Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim etti. Alabed, Erdoğan'ı kendisi için büyük bir rol model olarak nitelendirdi. Alabed, Başkan Erdoğan'la 10 yıl sonra yeniden bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek \"Gelecekte onun gibi büyük bir lider olmayı diliyorum.\" dedi.", "Halepli Alabed 10 yıl sonra yeniden Başkan Erdoğan ile bir arada: Benim için büyük bir rol model"),
  fx("Takvim", "takvim", "outlet", "2026-11-06T19:30:01Z", "Suriye'deki savaş sürecinde yaptığı sosyal medya paylaşımlarıyla tüm dünyaya sesini duyuran ve 10 yıl önce Cumhurbaşkanlığı Külliyesi'nde ağırlanan Halepli Bana Alabed, İstanbul Kongre Merkezi'nde düzenlenen TRT World Forum 2026'nın açılışında Basşkan Recep Tayyip Erdoğan ile yeniden bir araya geldi. Alabed, programda Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim etti.", "Suriye'nin sesi Bana Alabed 10 yıl sonra Başkan Erdoğan'la bir araya geldi: \"O benim için büyük bir rol model\""),
  fx("A Haber", "a-haber", "outlet", "2026-11-06T20:34:57Z", "Suriye'deki kanlı savaş sırasında sosyal medya paylaşımlarıyla Haleplilerin yaşadığı dramı tüm dünyaya duyuran ve 10 yıl önce Cumhurbaşkanlığı Külliyesi'nde ağırlanan Bana Alabed, Başkan Recep Tayyip...Devamı için tıklayınız", "Savaşın acılarını dünyaya duyurmuştu! Başkan Erdoğan ile Halepli Bana Alabed 10 yıl sonra yeniden bir arada"),
];
const EX_SIK_TITLE = "TİP Milletvekili Ahmet Şık'ın eşi Yonca Şık gözaltına alındı";
const EX_SIK = [
  fx("Elips Haber", "elips-haber", "outlet", "2026-11-10T10:55:00Z", "Yonca Verdioğlu Şık, TİP İstabul Milletvekili Ahmet Şık'ın eşidir. Sivil toplum ve medya alanındaki çalışmalarıyla tanınan Şık, İstanbul Üniversitesi İletişim Fakültesi Gazetecilik Bölümü mezunudur.", "Yonca Verdioğlu Şık kimdir?"),
  fx("Karar", "karar", "outlet", "2026-11-10T10:58:00Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, \"siyasal veya askeri casusluk\" suçlamasıyla evinden gözaltına alındı. Gözaltı kararının, TİP Genel Başkanı Erkan Baş'ın TBMM'de Şık'ın fon skandalına ilişkin paylaşımlarını silmesi karşılığında tutuklu arkadaşının serbest bırakılmasının teklif edildiğini açıklamasından bir gün sonra gelmesi dikkat çekti. Şık'ın arkadaşı Ahmet Saymadi de daha önce uyuşturucu soruşturması kapsamında tutuklanmıştı.", "Erkan Baş'ın 'tweeti silsin' açıklamasından bir gün sonra Ahmet Şık'ın eşine gözaltı"),
  fx("Haber7", "haber7", "outlet", "2026-11-10T10:59:00Z", "TİP İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık hakkında gözaltı ve ev araması iddialarının gerçeği yansıtmadığı açıklandı.  Yetkililer, Şık hakkında herhangi bir gözaltı kararı bulunmadığını belirtti.", "Ahmet Şık'ın eşi hakkında yeni gelişme: \"Gözaltına alındı\" iddiası yalan çıktı!"),
  fx("Haber.com", "haber-com", "outlet", "2026-11-10T11:05:19Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık “siyasal veya askeri casusluk” suçlamasıyla gözaltına alındı.", "TİP Milletvekili Ahmet Şık'ın eşi Yonca Şık gözaltına alındı"),
  fx("Takvim", "takvim", "outlet", "2026-11-10T11:25:48Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık’ın gözaltına alındığı yönündeki haberlerin gerçeği yansıtmadığı ortaya çıktı. Şık hakkında gözaltı kararı bulunmadığı, evinde arama yapılmadığı ve yalnızca ifadesinin alınması amacıyla mevcutlu olarak hazır edildiği belirtildi.", "Yonca Şık’ın gözaltına alındığı iddiası asılsız çıktı! Alman derneğiyle para trafiği mercek altında"),
  fx("GZT", "gzt", "outlet", "2026-11-10T11:31:07Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili ve gazeteci Ahmet Şık'ın eşi Yonca Verdioğlu Şık, hakkında yürütülen soruşturma kapsamında \"siyasal veya askeri casusluk\" iddiasıyla gözaltına alındı. Evinde gözaltına alınan Yonca Şık'ın Çağlayan'daki İstanbul Adalet Sarayı'na götürüldüğü öğrenildi. Gelişmenin ardından Yonca Şık'ın hayatı, yaşı, memleketi ve mesleği yeniden araştırılmaya başlandı. Peki, Yonca Şık kimdir, nereli, kaç yaşında ve ne iş yapıyor?", "Yonca Şık kimdir?  Ahmet Şık'ın eşi Yonca Şık nereli, kaç yaşında, ne iş yapıyor?"),
  fx("BirGün", "birgun", "outlet", "2026-11-10T11:34:00Z", "Partisinin İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık gözaltına alınmasıyla ilgili TBMM'de basın toplantısı düzenleyen TİP Genel Başkanı Erkan Baş, \"Bu kadar alçaklık, bu kadar mafyavari bir uygulama sanıyorum Türkiye Cumhuriyeti tarihinde eşine rastlanmamış bir şey\" dedi.", "Erkan Baş, Yonca Şık'ın gözaltına alınmasıyla ilgili konuştu: \"Saray rejimi bir mafya düzenine dönüşmüştür\""),
  fx("Sözcü", "sozcu", "outlet", "2026-11-10T11:37:10Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, \"siyasal veya askeri casusluk\" soruşturması kapsamında e...", "Yonca Verdioğlu Şık kimdir, Ahmet Şık'ın eşi neden göz altına alındı?"),
  fx("Yeni Akit", "yeni-akit", "outlet", "2026-11-10T11:43:00Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, 'siyasal veya askeri casusluk' soruşturması kapsamında gözaltına alındı.", "Bütün kamuoyuna yalan söyledikleri ortaya çıktı! Ahmet Şık’ın eşine casusluk incelemesi"),
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-10T11:52:09Z", "TİP İstanbul Milletvekili Ahmet Şık, eşi Yonca Verdioğlu Şık'ın gözaltına alınmasının ardından gündeme geldi. Gazetecilik geçmişi ve siyasi kariyeriyle tanınan Şık'ın hayatı, yaşı, memleketi ve hangi partiden milletvekili olduğu araştırılmaya başlandı. Peki, Ahmet Şık kimdir, milletvekili mi, hangi partiden? Ahmet Şık kaç yaşında, nereli? Detaylar haberimizde.", "Ahmet Şık kimdir, milletvekili mi, hangi partiden? Ahmet Şık kaç yaşında, nereli?"),
  fx("Cumhuriyet", "cumhuriyet", "outlet", "2026-11-10T11:55:00Z", "TİP İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık, “siyasal veya askeri casusluk” soruşturması kapsamında Beyoğlu’ndaki evinden gözaltına alınarak İstanbul Adliyesi’ne götürüldü. Peki, Ahmet Şık kimdir? TİP Milletvekili Ahmet Şık kaç yaşında, nereli? Ahmet Şık'ın eşi Yonca Şık kim, neden gözaltına alındı?", "Ahmet Şık kimdir? TİP Milletvekili Ahmet Şık kaç yaşında, nereli? Ahmet Şık'ın eşi kim, neden gözaltına alındı?"),
  fx("Diken", "diken", "outlet", "2026-11-10T13:51:13Z", "Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli? 10.11.2026 DikenTürkiye İşçi Partisi (TİP) İstanbul Milletvekili Sera Kadıgil, gözaltına alınan vekil Ahmet Şık'ın eşi Yonca Şık'ın kanser olduğunu söyledi.\nThe post Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli? appeared first on #site_linkat 10.11.2026 .", "Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli?"),
  fx("İstiklal", "istiklal", "outlet", "2026-11-10T15:30:18Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık hakkında yürütülen gözaltı sürecinde yeni gelişme yaşandı. Casusluk iddiasıyla gözaltına alınan Şık'ın ifadesinin ardından verilen karar belli oldu.", "Ahmet Şık'ın eşi Yonca Verdioğlu Şık hakkında yeni gelişme"),
  fx("Dokuz8 Haber", "dokuz8-haber", "outlet", "2026-11-10T17:19:22Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık, bir soruşturma kapsamında ifade vermek üzere gözaltına alındıktan sonra adli kontrolle serbest bırakıldı.", "Erkan Baş: Biz yarım adım bile geri atmayacağız, siz yolsuzluktan vazgeçeceksiniz"),
];

/** The stored summary of a cluster is the seed's description. */
const seedText = (members: ClusterDetailMember[], name: string): string => byName(members, name).article.description ?? "";

describe("h122-ozet-2: a bare quotation is not the Özet", () => {
  it.each([
    ["72abfb9f", QO_SINIRLIOGLU_TITLE, QO_SINIRLIOGLU, "Star"],
    ["4e0c0003", QO_KACIR_TITLE, QO_KACIR, "Haber7"],
    ["c859c91b", QO_ALABED_TITLE, QO_ALABED, "Takvim"],
  ])("%s: the Özet is %s's own sentence, credited to it", (_id, title, members, expected) => {
    const res = resolve(title, seedText(members, "Haberler.com"), members);
    expect(res?.source?.name).toBe(expected);
    expect(res?.text).toBe(shownOf(byName(members, expected)));
    expect(isQuoteOnly(res?.text ?? "")).toBe(false);
  });

  it("the meta description no longer starts with the bare quotation", () => {
    for (const [title, members] of [
      [QO_SINIRLIOGLU_TITLE, QO_SINIRLIOGLU],
      [QO_KACIR_TITLE, QO_KACIR],
      [QO_ALABED_TITLE, QO_ALABED],
    ] as const) {
      const res = resolve(title, seedText(members as ClusterDetailMember[], "Haberler.com"), members as ClusterDetailMember[]);
      const meta = describeForMeta({ count: members.length, attribution: res, title });
      expect(meta).toContain(res?.source?.name ?? "yok");
      expect(meta).not.toMatch(/Haberler\.com: ["“]/);
    }
  });

  it("a cluster with no qualifying member keeps the quotation (never blank)", () => {
    const only = QO_KACIR.filter((m) => ["Haberler.com", "Yeni Şafak"].includes(m.source.name));
    const res = resolve(QO_KACIR_TITLE, seedText(only, "Haberler.com"), only);
    expect(res?.source?.name).toBe("Haberler.com");
    expect(isQuoteOnly(res?.text ?? "")).toBe(true);
  });

  it("without agreeWithTitle the seed is shown as stored, tidied", () => {
    const res = summaryAttribution({ summary: seedText(QO_KACIR, "Haberler.com"), members: QO_KACIR, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Haberler.com");
    expect(isQuoteOnly(res?.text ?? "")).toBe(true);
  });

  it("a quotation with its speaker is a statement: it stays the Özet when it covers the headline", () => {
    const title = "Bakan Kacır Güney Koreli şirketlerle görüştü";
    const seed = fx("Tohum", "tohum", "outlet", "2026-11-04T10:00:00Z", 'Bakan Kacır, "Güney Koreli şirketlerle görüştük" dedi.', "x");
    const other = fx("Diğer", "diger", "outlet", "2026-11-04T10:05:00Z", "Bakan Kacır, Seul'de Güney Koreli şirketlerin yöneticileriyle bir araya geldi ve görüştü.", "x");
    expect(resolve(title, seed.article.description ?? "", [seed, other])?.source?.name).toBe("Tohum");
  });
});

describe("h122-ozet-2: a biography is not the Özet of a detention", () => {
  it("777ea7c5: Elips Haber's 'kimdir?' text gives way to the newest member that covers the headline", () => {
    const res = resolve(EX_SIK_TITLE, seedText(EX_SIK, "Elips Haber"), EX_SIK);
    expect(res?.source?.name).toBe("Dokuz8 Haber");
    expect(res?.text).toBe(shownOf(byName(EX_SIK, "Dokuz8 Haber")));
    expect(res?.text).not.toContain("mezunudur");
  });

  it("the same cluster under a headline that is an explainer keeps the biography seed", () => {
    const res = resolve("Yonca Verdioğlu Şık kimdir?", seedText(EX_SIK, "Elips Haber"), EX_SIK);
    expect(res?.source?.name).toBe("Elips Haber");
    expect(res?.text).toContain("mezunudur");
  });

  it("a seed whose article title is not an explainer is kept at 0.63, as before", () => {
    const members = EX_SIK.map((m) =>
      m.source.name === "Elips Haber" ? { ...m, article: { ...m.article, title: "Yonca Şık hakkında" } } : m,
    );
    const res = resolve(EX_SIK_TITLE, seedText(members, "Elips Haber"), members);
    expect(res?.source?.name).toBe("Elips Haber");
  });

  it("the other 'kimdir' articles of the cluster are no seed: nothing else changes", () => {
    const res = resolve(EX_SIK_TITLE, seedText(EX_SIK, "Karar"), EX_SIK);
    expect(res?.source?.name).toBe("Karar");
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-3 (hunt 122, 2026-11-11): Turkuvaz's "<cut>...Devamı için tıklayınız" seeds showed the
// cut ("…yanıt verdi. AK..."), and a clamp cut inside a quotation behind "şunları kaydetti:" showed
// the sentences in front of it and no statement. The members are the real outlet texts of the live
// clusters (dumped read-only 2026-11-11).
// ---------------------------------------------------------------------------

const CT_FAKIBABA_TITLE = "Ahmet Eşref Fakıbaba A Haber'e konuştu. Kapıyı aralayan sözler: \"AK Parti bana emek verdi, ben AK Parti'ye...\"";
const CT_FAKIBABA = [
  fx("A Haber", "a-haber", "outlet", "2026-11-10T19:51:25Z", "Geçtiğimiz günlerde İYİ Parti üyeliğinden ve Ankara Milletvekilliği görevinden istifa eden Ahmet Eşref Fakıbaba, AK Parti'ye geçeceği yönündeki kulis iddialarına A Haber ekranlarından yanıt verdi. AK...Devamı için tıklayınız", "Ahmet Eşref Fakıbaba A Haber'e konuştu! Kapıyı aralayan sözler: \"AK Parti bana emek verdi, ben AK Parti'ye...\""),
  fx("Takvim", "takvim", "outlet", "2026-11-10T20:42:28Z", "İYİ Parti üyeliğinden ve Ankara Milletvekilliği görevinden istifa eden Ahmet Eşref Fakıbaba, AK Parti'ye geçeceği yönündeki iddialara A Haber'de yanıt verdi. AK Parti ile herhangi bir temasının olmadığını belirten Fakıbaba, siyasi geleceğine ilişkin kararını henüz vermediğini söyledi. Olası bir teklife ise \"Büyük bir sürpriz olur mu sizce? Bilmiyorum.\" sözleriyle kapıyı açık bıraktı.", "Ahmet Eşref Fakıbaba'dan AK Parti'ye dönüş iddialarına A Haber'de yanıt! \"Büyük bir sürpriz olur mu sizce?\""),
];
const CT_MAHIROGLU_TITLE = "Mahiroğlu'nun kara para ağına 2. dalga operasyon: 7 şüpheli gözaltında";
const CT_MAHIROGLU = [
  fx("Sabah", "sabah", "outlet", "2026-11-10T19:55:43Z", "İstanbul Büyükşehir Belediyesi eski Başkanı Ekrem İmamoğlu'na verdiği destek nedeniyle Sarıyer'deki kaçak villasına göz yumulan Halk TV'nin firari eski sahibi Cafer Mahiroğlu'na yönelik rüşvet, ihaleye...Devamı için tıklayınız", "Mahiroğlu'nun kara para ağına 2. dalga operasyon: 7 şüpheli gözaltında"),
];
const CT_KABINE_TITLE = "Kabine Erdoğan liderliğinde toplanıyor: Masada kritik başlıklar";
const CT_KABINE = [
  fx("A Haber", "a-haber", "outlet", "2026-11-08T17:11:11Z", "Başkan Recep Tayyip Erdoğan başkanlığında Cumhurbaşkanlığı Külliyesi'nde toplanacak Cumhurbaşkanlığı Kabinesi; emekli maaşlarına yönelik yeni düzenlemelerden terörsüz Türkiye sürecine, fon...Devamı için tıklayınız", "CANLI | Kabine sona erdi! Başkan Erdoğan'dan önemli açıklamalar"),
  fx("İşçi Haber", "isci-haber", "niche", "2026-11-08T17:27:16Z", "Başkan Erdoğan liderliğinde toplanan Kabine, emekli maaşlarına yapılacak ek zam ve piyasa manipülasyonlarına karşı alınacak önlemleri değerlendirecek. Toplantıda ayrıca terörle mücadeledeki yeni süreç ve Türkiye'nin ev sahipliğinde gerçekleşecek uluslararası zirveler masaya yatırılacak.", "Kabine Erdoğan liderliğinde toplanıyor: Masada kritik başlıklar"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-11-09T06:16:48Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de saat 16.00'da toplanıyor. Yılın en kritik toplantılarından birinde emeklilere refah payı düzenlemesinden dev yatırım fonu soruşturmasına, Terörsüz Türkiye sürecinden ABD-İran gerilimine kadar çok sayıda hayati başlık masaya yatırılacak.", "Beştepe'de kritik Kabine toplanıyor: Masada emekli zammı var"),
  fx("Yeni Mesaj", "yeni-mesaj", "outlet", "2026-11-09T07:45:00Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak.Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de saat 16.00'da toplanacak kabinenin gündeminde; emeklilere refah payı düzenlemesi , fon ...", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak"),
  fx("F5 Haber", "f5-haber", "aggregator", "2026-11-09T08:20:00Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak.", "Kabine toplanıyor. Emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak"),
];
const CT_DURAN_TITLE = "Burhanettin Duran: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek";
const CT_DURAN = [
  fx("Haberler.com", "haberler-com", "aggregator", "2026-11-09T19:58:05Z", "- \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek\"", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı:"),
  fx("Milliyet", "milliyet", "outlet", "2026-11-09T20:08:52Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, NSosyal hesabından, Türkiye'nin ev sahipliğinde Antalya'da düzenlenen Birleşmiş Milletler İklim Değişikliği Çerçeve Sözleşmesi'nin 31. Taraflar Konferansı'na (COP31) ilişkin paylaşımda bulundu.\nTürkiye'nin, COP31'e başkanlık ve ev sahipliği yaparak küresel iklim diplomasisinin merkezinde yer aldığını belirten Duran, şunları kaydetti: \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin ...", "İletişim Başkanı Duran'dan 'COP31' paylaşımı: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  fx("Diriliş Postası", "dirilis-postasi", "outlet", "2026-11-09T20:15:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "Burhanettin Duran: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  fx("Yeni Şafak", "yeni-safak", "outlet", "2026-11-09T20:25:05Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran NSosyal hesabından, Türkiye'nin ev sahipliğinde Antalya'da düzenlenen Birleşmiş Milletler İklim Değişikliği Çerçeve Sözleşmesi'nin 31. Taraflar Konferansı'na (COP31) ilişkin paylaşımda bulundu. Türkiye'nin, COP31'e başkanlık ve ev sahipliği yaparak küresel iklim diplomasisinin merkezinde yer aldığını belirten Duran, şunları kaydetti: \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin k...", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı"),
  fx("Haber Global", "haber-global", "outlet", "2026-11-09T20:52:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  fx("Elips Haber", "elips-haber", "outlet", "2026-11-09T21:07:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "İletişim Başkanı Duran'dan 'COP31' paylaşımı"),
  fx("TRT Haber", "trt-haber", "outlet", "2026-11-09T21:21:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek\" dedi.", "İletişim Başkanı Duran: Türkiye küresel iklim diplomasisinin merkezinde yer alıyor"),
];
const CT_YAYMAN_TITLE = "AK Parti'li Yayman'dan yeni anayasa açıklaması";
const CT_YAYMAN = [
  fx("Milliyet", "milliyet", "outlet", "2026-11-07T12:49:01Z", "Yayman, Türkiye Yüzyılı Buluşmaları kapsamında AK Parti Mersin İl Başkanlığınca Suphi Öner Öğretmenevi'nde düzenlenen Basın Buluşması programına katıldı.\nBurada konuşan Yayman, AK Parti'nin krizlerle mücadele ederek bu noktaya geldiğini söyledi.\nFon meselesiyle ilgili değerlendirmede bulunan Yayman, konuşmasını şöyle sürdürdü: \"Cumhurbaşkanı'mızın söylediği gibi biz bunu da aşacağız çünkü AK Parti '3 Y' ile kurulmuştur. Yasaklarla mücadele etmek, sessiz devrimler başarmıştır. Yoksullukla müca...", "AK Parti'li Yayman'dan yeni anayasa açıklaması"),
  fx("Posta", "posta", "outlet", "2026-11-07T13:33:50Z", "Yayman, Türkiye Yüzyılı Buluşmaları kapsamında AK Parti Mersin İl Başkanlığınca Suphi Öner Öğretmenevi'nde düzenlenen Basın Buluşması programına katıldı.\nBurada konuşan Yayman, AK Parti'nin krizlerle mücadele ederek bu noktaya geldiğini söyledi.\nFon meselesiyle ilgili değerlendirmede bulunan Yayman, konuşmasını şöyle sürdürdü:\n\"Cumhurbaşkanı'mızın söylediği gibi biz bunu da aşacağız çünkü AK Parti '3 Y' ile kurulmuştur. Yasaklarla mücadele etmek, sessiz devrimler başarmıştır. Yoksullukla müca...", "AK Parti'li Yayman: Türkiye'yi dünyanın en gelişmiş 10 ülkesinden birisi haline getireceğiz"),
];

describe("h122-ozet-3: a cut that hides the statement is not the Özet", () => {
  it("605765b8: the Özet is the A Haber sentence, not '...yanıt verdi. AK...'", () => {
    const res = resolve(CT_FAKIBABA_TITLE, seedText(CT_FAKIBABA, "A Haber"), CT_FAKIBABA);
    expect(res?.source?.name).toBe("A Haber");
    expect(res?.text).toBe(
      "Geçtiğimiz günlerde İYİ Parti üyeliğinden ve Ankara Milletvekilliği görevinden istifa eden Ahmet Eşref Fakıbaba, AK Parti'ye geçeceği yönündeki kulis iddialarına A Haber ekranlarından yanıt verdi.",
    );
    const meta = describeForMeta({ count: 2, attribution: res, title: CT_FAKIBABA_TITLE });
    expect(meta).not.toContain("...");
    expect(meta.startsWith("2 kaynak. A Haber: Geçtiğimiz günlerde İYİ Parti")).toBe(true);
  });

  it("dfaaceac: the cut seed (0.43) gives way to Yeni Şafak (0.71)", () => {
    const res = resolve(CT_KABINE_TITLE, seedText(CT_KABINE, "A Haber"), CT_KABINE);
    expect(res?.source?.name).toBe("Yeni Şafak");
    expect(res?.text).toBe(shownOf(byName(CT_KABINE, "Yeni Şafak")));
  });

  it("7fd1bd19: a lone cut seed is shown cut with one '…', never '...' and never the CTA", () => {
    const res = resolve(CT_MAHIROGLU_TITLE, seedText(CT_MAHIROGLU, "Sabah"), CT_MAHIROGLU);
    expect(res?.source?.name).toBe("Sabah");
    expect(res?.text.endsWith("Cafer Mahiroğlu'na yönelik rüşvet…")).toBe(true);
    expect(res?.text).not.toMatch(/\.\.\.|Devamı/);
    const without = summaryAttribution({ summary: seedText(CT_MAHIROGLU, "Sabah"), members: CT_MAHIROGLU, wire: NOT_WIRE });
    expect(without?.text).toBe(res?.text);
  });

  it("837fa770: Milliyet's clamp that lost its quotation gives way to a 1.00 outlet (the newest, TRT Haber)", () => {
    const res = resolve(CT_DURAN_TITLE, seedText(CT_DURAN, "Milliyet"), CT_DURAN);
    expect(res?.source?.name).toBe("TRT Haber");
    expect(res?.text).toBe(shownOf(byName(CT_DURAN, "TRT Haber")));
    expect(res?.text).toContain("küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek");
  });

  it("837fa770: without the headline (rss, digest, cards) the seed shows its first paragraph and no 'şunları kaydetti'", () => {
    const res = summaryAttribution({ summary: seedText(CT_DURAN, "Milliyet"), members: CT_DURAN, wire: NOT_WIRE });
    expect(res?.source?.name).toBe("Milliyet");
    expect(res?.text.endsWith("ilişkin paylaşımda bulundu.")).toBe(true);
    expect(res?.text).not.toContain("şunları kaydetti");
  });

  it("98266829: the only other member holds the same words, so the seed stays and ends at 'söyledi.'", () => {
    const res = resolve(CT_YAYMAN_TITLE, seedText(CT_YAYMAN, "Milliyet"), CT_YAYMAN);
    expect(res?.source?.name).toBe("Milliyet");
    expect(res?.text.endsWith("AK Parti'nin krizlerle mücadele ederek bu noktaya geldiğini söyledi.")).toBe(true);
    expect(res?.text).not.toMatch(/şöyle sürdürdü|…$/);
  });

  it("every one of the five clusters yields a non-empty Özet that does not end in '...'", () => {
    for (const [title, members, seedName] of [
      [CT_FAKIBABA_TITLE, CT_FAKIBABA, "A Haber"],
      [CT_MAHIROGLU_TITLE, CT_MAHIROGLU, "Sabah"],
      [CT_KABINE_TITLE, CT_KABINE, "A Haber"],
      [CT_DURAN_TITLE, CT_DURAN, "Milliyet"],
      [CT_YAYMAN_TITLE, CT_YAYMAN, "Milliyet"],
    ] as const) {
      const list = members as ClusterDetailMember[];
      const res = resolve(title, seedText(list, seedName), list);
      expect(res, title).not.toBeNull();
      expect(res?.text.endsWith("..."), title).toBe(false);
    }
  });
});
