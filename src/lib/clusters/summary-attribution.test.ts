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
