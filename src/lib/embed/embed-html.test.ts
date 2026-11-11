import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { ClusterDetail, ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { BiasCategory, BiasDistribution, MediaDnaZone, SourceKind } from "@/types";
import {
  EMBED_GENERIC_TITLE,
  EMBED_TITLE_MAX,
  NO_HEADLINE_TITLE,
  buildEmbedModel,
  displayHeadline,
  renderEmbedHtml,
  renderEmbedMessageHtml,
  safeEmbedTitle,
} from "./embed-html";
import { escapeHtml } from "./embed-snippet";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
const ORIGIN = "https://tayf.test";

function dist(partial: Partial<BiasDistribution> = {}): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

function detail(over: {
  title?: string;
  distribution?: BiasDistribution;
  isBlindspot?: boolean;
  blindspotSide?: BiasCategory | null;
  sourceCount?: number;
  members?: ClusterDetailMember[];
  titleMethod?: ClusterDetail["cluster"]["title_method"];
  /** Omitted: the field is absent, like a cache entry written before it existed. */
  recallMatchedZones?: MediaDnaZone[];
}): ClusterDetail {
  return {
    cluster: {
      id: ID,
      title_tr: over.title ?? "Merkez Bankası faizi sabit tuttu",
      title_original: null,
      title_method: over.titleMethod ?? null,
      summary_tr: "özet",
      article_count: 4,
      bias_distribution: over.distribution ?? dist({ pro_government: 2, center: 1, opposition: 1 }),
      is_blindspot: over.isBlindspot ?? false,
      blindspot_side: over.blindspotSide ?? null,
      first_published: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      is_archived: false,
      merged_into: null,
    },
    members: over.members ?? [],
    allSources: [],
    wire: { effectiveArticleCount: over.sourceCount ?? 4 } as ClusterDetail["wire"],
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
    ...(over.recallMatchedZones === undefined ? {} : { recallMatchedZones: over.recallMatchedZones }),
  };
}

function memberOf(slug: string, kind: SourceKind | undefined, bias: BiasCategory, n = 1): ClusterDetailMember {
  return {
    source: {
      id: slug,
      name: slug,
      slug,
      url: `https://${slug}.example`,
      rss_url: `https://${slug}.example/rss`,
      bias,
      logo_url: null,
      active: true,
      kind,
      trustee_since: null,
      trustee_note: null,
    },
    article: {
      id: `${slug}-${n}`,
      title: `${slug} başlığı ${n}`,
      url: `https://${slug}.example/haber/${n}`,
      published_at: "2026-10-01T00:00:00Z",
      image_url: null,
      content_hash: `hash-${slug}-${n}`,
    },
  };
}

// Shaped like cluster 0b127dc3-444a-48fb-a045-6d97086e4074 (h57-outbound-1):
// nine voting İktidar members, then son-dakika (aggregator, center: Bağımsız),
// isci-haber (niche, opposition: Muhalefet) and haberler-com (aggregator,
// gov_leaning: İktidar).
const VOTING9: ClusterDetailMember[] = [
  ...Array.from({ length: 5 }, (_, i) => memberOf(`outlet-${i}`, "outlet", "pro_government")),
  ...Array.from({ length: 3 }, (_, i) => memberOf(`leaning-${i}`, "outlet", "gov_leaning")),
  memberOf("anadolu-ajansi", "wire", "pro_government"),
];
const SON_DAKIKA = memberOf("son-dakika", "aggregator", "center");
const ISCI_HABER = memberOf("isci-haber", "niche", "opposition");
const HABERLER_COM = memberOf("haberler-com", "aggregator", "gov_leaning");
const FIXTURE_MEMBERS = [...VOTING9, SON_DAKIKA, ISCI_HABER, HABERLER_COM];
const CONTROL_MEMBERS = [...VOTING9, HABERLER_COM];
const NINE_IKTIDAR = dist({ pro_government: 6, gov_leaning: 3 });

describe("safeEmbedTitle", () => {
  it("passes an eligible title through", () => {
    expect(safeEmbedTitle("Merkez Bankası faizi sabit tuttu", "yedek")).toBe("Merkez Bankası faizi sabit tuttu");
  });

  it("trims surrounding whitespace", () => {
    expect(safeEmbedTitle("  Başlık \n", "yedek")).toBe("Başlık");
  });

  it("falls back for a title the KVKK private-individual filter rejects", () => {
    expect(safeEmbedTitle("17 yaşındaki genç tutuklandı", "yedek")).toBe("yedek");
    expect(safeEmbedTitle("SANIK hakkında karar", "yedek")).toBe("yedek");
  });

  it("falls back for an empty or whitespace-only title", () => {
    expect(safeEmbedTitle("", "yedek")).toBe("yedek");
    expect(safeEmbedTitle("   ", "yedek")).toBe("yedek");
  });

  it("truncates by code point to exactly EMBED_TITLE_MAX with an ellipsis", () => {
    const out = safeEmbedTitle("a".repeat(500), "yedek");
    expect(Array.from(out)).toHaveLength(EMBED_TITLE_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const title = "a".repeat(EMBED_TITLE_MAX - 2) + "😀😀😀😀";
    const out = safeEmbedTitle(title, "yedek");
    expect(Array.from(out)).toHaveLength(EMBED_TITLE_MAX);
    // a lone surrogate would make encodeURIComponent throw
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it("leaves a title of exactly EMBED_TITLE_MAX code points untouched", () => {
    const title = "b".repeat(EMBED_TITLE_MAX);
    expect(safeEmbedTitle(title, "yedek")).toBe(title);
  });

  // A stored title with no letter or digit ('&nbsp', '-') used to pass every
  // check above and reach a third-party page as an empty heading. It is now
  // shown as the neutral "Haber"; only an EMPTY title keeps the caller's fallback.
  it.each(["&nbsp", "&nbsp;", "&amp;nbsp", "&#160;", "-", "—", "…", "...", "«»", "ㅤ", " &nbsp; "])(
    "shows %j as the neutral 'Haber' instead of an empty heading",
    (raw) => {
      expect(safeEmbedTitle(raw, "yedek")).toBe("Haber");
    },
  );

  it("still uses the caller's fallback for an empty title", () => {
    expect(safeEmbedTitle("", "yedek")).toBe("yedek");
    expect(safeEmbedTitle(" \n\t ", "yedek")).toBe("yedek");
  });

  it("still uses the caller's fallback when the PII filter rejects a real headline", () => {
    expect(safeEmbedTitle("17 yaşındaki genç tutuklandı", "yedek")).toBe("yedek");
  });

  it.each(["a", "2025", "Gol!", "R&D"])("keeps the short real headline %j", (raw) => {
    expect(safeEmbedTitle(raw, "yedek")).toBe(raw);
  });
});

// h64-ogcards-2. The embed heading and the oEmbed title cut at a hard 139 code
// points ('…hesaba çekilme…', which turns the stored 'çekilmeli' into a noun).
// safeEmbedTitle() now cuts like the OG card: at a word, never inside one. The
// title is the real neutral title of cluster d26a31d4-5627-49b4-bef0-e68d60eccde5
// (142 code points, pinned because the cluster gets re-titled).
const NEUTRAL_D26A31D4 =
  "AKP’li isim Fatma Betül’ün sevk yazısındaki gerekçeye dikkat çekti: ‘Biliniyordu… İhmali veya kastı olan kamu görevlileri de hesaba çekilmeli’";

describe("safeEmbedTitle word-boundary cut", () => {
  it("cuts the d26a31d4 neutral title after 'hesaba', not inside 'çekilmeli'", () => {
    expect(Array.from(NEUTRAL_D26A31D4).length).toBeGreaterThan(EMBED_TITLE_MAX);
    const out = safeEmbedTitle(NEUTRAL_D26A31D4, "yedek");
    expect(out.endsWith("hesaba…")).toBe(true);
    expect(out).not.toContain("çekilme");
    expect(Array.from(out).length).toBeLessThanOrEqual(EMBED_TITLE_MAX);
  });

  it("trims first, then cuts at a word (surrounding whitespace never eats the budget)", () => {
    const out = safeEmbedTitle(`   ${NEUTRAL_D26A31D4}  \n`, "yedek");
    expect(out.endsWith("hesaba…")).toBe(true);
    expect(out.startsWith("AKP’li")).toBe(true);
  });

  it("keeps the KVKK fallback: a rejected long title is still replaced, never cut", () => {
    expect(safeEmbedTitle(`17 yaşındaki genç tutuklandı ${"kelime ".repeat(40)}`, "yedek")).toBe("yedek");
    expect(safeEmbedTitle("SANIK hakkında karar", "yedek")).toBe("yedek");
  });

  it("keeps the order of the filters: empty -> fallback, contentless -> 'Haber', then the cut", () => {
    expect(safeEmbedTitle("   ", "yedek")).toBe("yedek");
    expect(safeEmbedTitle("&nbsp", "yedek")).toBe("Haber");
    expect(safeEmbedTitle("…", "yedek")).toBe("Haber");
  });

  it("a blank-free title is still a hard cut of exactly EMBED_TITLE_MAX code points", () => {
    const out = safeEmbedTitle("u".repeat(500), "yedek");
    expect(out).toBe(`${"u".repeat(EMBED_TITLE_MAX - 1)}…`);
  });

  it("cuts first and escapes after: the raw characters are counted and no entity is split", () => {
    // 'a&' x 100 has no blank: a hard cut at 139 raw characters (the escaped form
    // is far longer). Escaping the cut text keeps every '&amp;' whole.
    const m = buildEmbedModel(detail({ title: "a&".repeat(100) }), ORIGIN);
    expect(Array.from(m.title)).toHaveLength(EMBED_TITLE_MAX);
    const html = renderEmbedHtml(m);
    expect(html).toContain(`<h1>${escapeHtml(m.title)}</h1>`);
    // Every '&' in the heading starts a whole '&amp;': nothing is cut mid-entity.
    const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
    expect(h1.replace(/&amp;/g, "")).not.toContain("&");
    expect(h1.endsWith("…")).toBe(true);
  });

  it("the framed heading and the document <title> both show the word cut", () => {
    const m = buildEmbedModel(detail({ title: NEUTRAL_D26A31D4 }), ORIGIN);
    const html = renderEmbedHtml(m);
    expect(html).toContain("hesaba…</h1>");
    expect(html).toContain("hesaba… · Tayf</title>");
  });
});

describe("displayHeadline / NO_HEADLINE_TITLE", () => {
  it("names the neutral title 'Haber'", () => {
    expect(NO_HEADLINE_TITLE).toBe("Haber");
  });

  it.each(["", "   ", "&nbsp", "&nbsp;", "&amp;nbsp;", "&#160;", "-", "—", "…", "ㅤ"])(
    "returns 'Haber' for the contentless title %j",
    (raw) => {
      expect(displayHeadline(raw)).toBe("Haber");
    },
  );

  it("returns a real headline unchanged (no trim, no cut)", () => {
    expect(displayHeadline("Merkez Bankası faizi sabit tuttu")).toBe("Merkez Bankası faizi sabit tuttu");
    expect(displayHeadline("  Başlık  ")).toBe("  Başlık  ");
    const long = "u".repeat(500);
    expect(displayHeadline(long)).toBe(long);
  });

  it.each(["a", "2025", "Gol!", "R&D"])("returns the short real headline %j unchanged", (raw) => {
    expect(displayHeadline(raw)).toBe(raw);
  });

  it("does not run the private-individual filter (that stays in safeEmbedTitle)", () => {
    expect(displayHeadline("17 yaşındaki genç tutuklandı")).toBe("17 yaşındaki genç tutuklandı");
  });
});

describe("buildEmbedModel with a contentless cluster title", () => {
  it("shows 'Haber' in the widget heading and the document <title>", () => {
    const m = buildEmbedModel(detail({ title: "&nbsp" }), ORIGIN);
    expect(m.title).toBe("Haber");
    const html = renderEmbedHtml(m);
    expect(html).toContain("<h1>Haber</h1>");
    expect(html).toContain("<title>Haber · Tayf</title>");
  });
});

describe("cluster OG image headline (source scan)", () => {
  // opengraph-image.tsx is an async-data route (no render test of its own for
  // this): pin the wiring so the contentless-title swap cannot be dropped or
  // moved after the length clamp (which would cut an unswapped title).
  const ogSource = readFileSync(resolve(__dirname, "../../app/cluster/[id]/opengraph-image.tsx"), "utf8");
  const code = ogSource
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  it("imports displayHeadline from the embed-html module", () => {
    expect(code).toMatch(/import\s*{[^}]*\bdisplayHeadline\b[^}]*}\s*from\s*["']@\/lib\/embed\/embed-html["']/);
  });

  it("applies it to the stored title before the length clamp", () => {
    const applied = code.indexOf("displayHeadline(cluster.title_tr)");
    expect(applied).toBeGreaterThan(-1);
    // The swapped headline is the argument of the clamp (h20-contracts-1:
    // clampOgTitle replaced the inline slice), so the swap always runs first.
    expect(code).toMatch(/clampOgTitle\(\s*displayHeadline\(cluster\.title_tr\)/);
    expect(code.indexOf("clampOgTitle(")).toBeLessThan(applied);
  });

  it("clamps the swapped headline, never the raw stored title", () => {
    expect(code).not.toContain("cluster.title_tr.length");
    expect(code).not.toContain("cluster.title_tr.slice");
    expect(code).not.toMatch(/clampOgTitle\(\s*cluster\.title_tr/);
    // The inline mid-word cut is gone; clampOgTitle owns the cut.
    expect(code).not.toContain("titleMaxChars");
    expect(code).toMatch(/import\s*{[^}]*\bclampOgTitle\b[^}]*}\s*from\s*["']@\/lib\/seo\/og-title["']/);
  });

  it("re-exports nothing new from the route file", () => {
    expect(code).not.toMatch(/export\s*{[^}]*\b(displayHeadline|NO_HEADLINE_TITLE)\b/);
    expect(code).not.toMatch(/export\s+(const|function)\s+(displayHeadline|NO_HEADLINE_TITLE)\b/);
  });
});

describe("buildEmbedModel", () => {
  it("derives counts, percents, total and source count from the cluster", () => {
    const m = buildEmbedModel(detail({ sourceCount: 7 }), ORIGIN);
    expect(m.counts).toEqual({ iktidar: 2, bagimsiz: 1, muhalefet: 1 });
    expect(m.percents).toEqual({ iktidar: 50, bagimsiz: 25, muhalefet: 25 });
    expect(m.total).toBe(4);
    expect(m.sourceCount).toBe(7);
  });

  it("uses the cluster title", () => {
    expect(buildEmbedModel(detail({ title: "Başlık X" }), ORIGIN).title).toBe("Başlık X");
  });

  it("swaps a KVKK-rejected title for the generic heading", () => {
    const m = buildEmbedModel(detail({ title: "Ali Yılmaz adlı şüpheli yakalandı" }), ORIGIN);
    expect(m.title).toBe(EMBED_GENERIC_TITLE);
    expect(EMBED_GENERIC_TITLE).toBe("Bu haberin medya yelpazesi");
  });

  it("builds the utm-tagged cluster link and tolerates a trailing slash on the origin", () => {
    const expected = `${ORIGIN}/cluster/${ID}?utm_source=embed&utm_medium=iframe&utm_campaign=cluster`;
    expect(buildEmbedModel(detail({}), ORIGIN).href).toBe(expected);
    expect(buildEmbedModel(detail({}), `${ORIGIN}/`).href).toBe(expected);
  });

  describe("ribbon", () => {
    it("is null when the cluster is not a blindspot", () => {
      expect(buildEmbedModel(detail({ isBlindspot: false }), ORIGIN).ribbon).toBeNull();
    });

    it("says 'sadece … yazdı' at a 100% share", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: dist({ pro_government: 3, state_media: 2 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: sadece iktidar yazdı");
    });

    it("says '… ağırlıklı', not 'sadece', at 250/1/0 although the share rounds to 100", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: dist({ pro_government: 250, center: 1 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: iktidar ağırlıklı");
    });

    it("does not say 'sadece' when the side's zone is not the only zone with sources", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "opposition", distribution: dist({ pro_government: 5 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: muhalefet ağırlıklı");
    });

    it("says '… ağırlıklı' below 100%", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "opposition", distribution: dist({ opposition: 9, center: 1 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: muhalefet ağırlıklı");
    });

    it("uses the Turkish lower-case label for the independent zone", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "center", distribution: dist({ center: 5 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: sadece bağımsız yazdı");
    });

    it("falls back to the tallied dominant zone when no side is recorded", () => {
      const m = buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: null, distribution: dist({ opposition: 4 }) }),
        ORIGIN,
      );
      expect(m.ribbon).toBe("Kör nokta: sadece muhalefet yazdı");
    });

    it("falls back to iktidar when there is no tally at all", () => {
      const m = buildEmbedModel(detail({ isBlindspot: true, blindspotSide: null, distribution: dist() }), ORIGIN);
      expect(m.ribbon).toBe("Kör nokta: iktidar ağırlıklı");
    });

    // h57-outbound-1: the same qualifier /blindspots and the cluster timeline use.
    describe("non-voting sources from another zone (h57-outbound-1)", () => {
      const blindspot = (members: ClusterDetailMember[], over: Parameters<typeof detail>[0] = {}) =>
        buildEmbedModel(
          detail({
            isBlindspot: true,
            blindspotSide: "pro_government",
            distribution: NINE_IKTIDAR,
            sourceCount: 12,
            members,
            ...over,
          }),
          ORIGIN,
        ).ribbon;

      it("says 'spektrumda sadece iktidar' for the 0b127dc3-shaped fixture", () => {
        expect(blindspot(FIXTURE_MEMBERS)).toBe("Kör nokta: spektrumda sadece iktidar");
      });

      it("keeps 'sadece iktidar yazdı' for the control (only haberler-com, inside the zone)", () => {
        expect(blindspot(CONTROL_MEMBERS)).toBe("Kör nokta: sadece iktidar yazdı");
      });

      it("keeps 'sadece iktidar yazdı' when the detail carries no members", () => {
        expect(blindspot([])).toBe("Kör nokta: sadece iktidar yazdı");
      });

      it("counts a source once however many articles it wrote, and still qualifies", () => {
        expect(blindspot([...VOTING9, ISCI_HABER, memberOf("isci-haber", "niche", "opposition", 2)])).toBe(
          "Kör nokta: spektrumda sadece iktidar",
        );
      });

      it("ignores voting members of other zones (they are in the tally already)", () => {
        expect(blindspot([...VOTING9, memberOf("sozcu", "outlet", "opposition"), memberOf("x", undefined, "center")])).toBe(
          "Kör nokta: sadece iktidar yazdı",
        );
      });

      it("leaves '… ağırlıklı' alone, with or without outsiders", () => {
        const members = [...FIXTURE_MEMBERS];
        const over = { distribution: dist({ pro_government: 9, opposition: 1 }), blindspotSide: "pro_government" as const };
        expect(blindspot(members, over)).toBe("Kör nokta: iktidar ağırlıklı");
        expect(blindspot([], over)).toBe("Kör nokta: iktidar ağırlıklı");
        expect(blindspot(members, { distribution: dist({ pro_government: 250, center: 1 }) })).toBe(
          "Kör nokta: iktidar ağırlıklı",
        );
      });

      it("qualifies the fallback zone too when no side is recorded", () => {
        expect(blindspot(FIXTURE_MEMBERS, { blindspotSide: null })).toBe("Kör nokta: spektrumda sadece iktidar");
      });

      it("uses the Turkish lower-case label for the other zones", () => {
        const members = [memberOf("a", "outlet", "center"), memberOf("b", "niche", "opposition")];
        expect(blindspot(members, { blindspotSide: "center", distribution: dist({ center: 5 }) })).toBe(
          "Kör nokta: spektrumda sadece bağımsız",
        );
        const opp = [memberOf("a", "outlet", "opposition"), memberOf("b", "aggregator", "gov_leaning")];
        expect(blindspot(opp, { blindspotSide: "opposition", distribution: dist({ opposition: 4 }) })).toBe(
          "Kör nokta: spektrumda sadece muhalefet",
        );
      });

      it("has no ribbon for a cluster that is not a blindspot, whatever its members", () => {
        const m = buildEmbedModel(detail({ isBlindspot: false, members: FIXTURE_MEMBERS }), ORIGIN);
        expect(m.ribbon).toBeNull();
      });

      it("changes nothing but the ribbon (counts, percents, total, source count, link)", () => {
        const withMembers = buildEmbedModel(
          detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 12, members: FIXTURE_MEMBERS }),
          ORIGIN,
        );
        const without = buildEmbedModel(
          detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 12, members: [] }),
          ORIGIN,
        );
        expect({ ...withMembers, ribbon: null }).toEqual({ ...without, ribbon: null });
        expect(withMembers.sourceCount).toBe(12);
        expect(withMembers.total).toBe(9);
      });

      it("renders the qualified ribbon in the framed document, between the brand and the headline", () => {
        const html = renderEmbedHtml(
          buildEmbedModel(
            detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 12, members: FIXTURE_MEMBERS }),
            ORIGIN,
          ),
        );
        expect(html).toContain('<div class="r">Kör nokta: spektrumda sadece iktidar</div>');
        expect(html).not.toContain("sadece iktidar yazdı");
        expect(html.indexOf("TAYF ·")).toBeLessThan(html.indexOf("spektrumda"));
        expect(html.indexOf("spektrumda")).toBeLessThan(html.indexOf("<h1"));
      });
    });

    // h108-sharesurfaces-1: cluster 0746c9d2 (9 İktidar; Jev matched Yeniçağ and
    // Elips Haber, Muhalefet, with the same event in another cluster) printed
    // "Kör nokta: sadece iktidar yazdı" here while /blindspots said "Kümede sadece
    // İktidar". ClusterDetail.recallMatchedZones is already on the detail.
    describe("zones Jev matched (h108-sharesurfaces-1)", () => {
      const blindspot = (
        recallMatchedZones: MediaDnaZone[] | undefined,
        members: ClusterDetailMember[] = VOTING9,
        over: Parameters<typeof detail>[0] = {},
      ) =>
        buildEmbedModel(
          detail({
            isBlindspot: true,
            blindspotSide: "pro_government",
            distribution: NINE_IKTIDAR,
            sourceCount: 9,
            members,
            recallMatchedZones,
            ...over,
          }),
          ORIGIN,
        ).ribbon;

      it("says 'kümede sadece iktidar' for a 0746c9d2-shaped cluster, never 'yazdı'", () => {
        const ribbon = blindspot(["muhalefet"]);
        expect(ribbon).toBe("Kör nokta: kümede sadece iktidar");
        expect(ribbon).not.toContain("sadece iktidar yazdı");
        expect(ribbon).not.toContain("yazdı");
      });

      it("one matched zone is enough, and so are two", () => {
        expect(blindspot(["bagimsiz"])).toBe("Kör nokta: kümede sadece iktidar");
        expect(blindspot(["bagimsiz", "muhalefet"])).toBe("Kör nokta: kümede sadece iktidar");
      });

      it("is byte-identical to today's ribbon with [] (a failed lookup) and with the field undefined (an old cache entry)", () => {
        expect(blindspot([])).toBe("Kör nokta: sadece iktidar yazdı");
        expect(blindspot(undefined)).toBe("Kör nokta: sadece iktidar yazdı");
        const plain = buildEmbedModel(
          detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 9, members: VOTING9 }),
          ORIGIN,
        );
        expect(plain.ribbon).toBe("Kör nokta: sadece iktidar yazdı");
        expect(JSON.stringify(plain)).toBe(
          JSON.stringify(
            buildEmbedModel(
              detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 9, members: VOTING9, recallMatchedZones: [] }),
              ORIGIN,
            ),
          ),
        );
      });

      it("keeps the toplayıcı / niş qualifier ahead of it (precedence, as on /blindspots)", () => {
        expect(blindspot(["bagimsiz"], FIXTURE_MEMBERS, { sourceCount: 12 })).toBe(
          "Kör nokta: spektrumda sadece iktidar",
        );
      });

      it("leaves '… ağırlıklı' alone: another zone has a voting source", () => {
        expect(
          blindspot(["bagimsiz"], VOTING9, { distribution: dist({ pro_government: 9, opposition: 1 }) }),
        ).toBe("Kör nokta: iktidar ağırlıklı");
        expect(blindspot(["bagimsiz"], VOTING9, { distribution: dist({ pro_government: 250, center: 1 }) })).toBe(
          "Kör nokta: iktidar ağırlıklı",
        );
      });

      it("qualifies the tally's fallback zone too, with its Turkish lower-case label", () => {
        expect(blindspot(["muhalefet"], VOTING9, { blindspotSide: null })).toBe("Kör nokta: kümede sadece iktidar");
        const opp = [memberOf("a", "outlet", "opposition")];
        expect(
          blindspot(["iktidar"], opp, { blindspotSide: "opposition", distribution: dist({ opposition: 4 }) }),
        ).toBe("Kör nokta: kümede sadece muhalefet");
        expect(
          blindspot(["iktidar"], [memberOf("a", "outlet", "center")], { blindspotSide: "center", distribution: dist({ center: 5 }) }),
        ).toBe("Kör nokta: kümede sadece bağımsız");
      });

      it("has no ribbon for a cluster that is not a blindspot, whatever Jev matched", () => {
        const m = buildEmbedModel(
          detail({ isBlindspot: false, members: VOTING9, recallMatchedZones: ["muhalefet"] }),
          ORIGIN,
        );
        expect(m.ribbon).toBeNull();
      });

      it("changes nothing but the ribbon (counts, percents, total, source count, link)", () => {
        const matched = buildEmbedModel(
          detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 9, members: VOTING9, recallMatchedZones: ["muhalefet"] }),
          ORIGIN,
        );
        const plain = buildEmbedModel(
          detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 9, members: VOTING9 }),
          ORIGIN,
        );
        expect({ ...matched, ribbon: null }).toEqual({ ...plain, ribbon: null });
        expect(matched.total).toBe(9);
      });

      it("renders the new ribbon in the framed document, between the brand and the headline", () => {
        const html = renderEmbedHtml(
          buildEmbedModel(
            detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: NINE_IKTIDAR, sourceCount: 9, members: VOTING9, recallMatchedZones: ["muhalefet"] }),
            ORIGIN,
          ),
        );
        expect(html).toContain('<div class="r">Kör nokta: kümede sadece iktidar</div>');
        expect(html).not.toContain("sadece iktidar yazdı");
        expect(html.indexOf("TAYF ·")).toBeLessThan(html.indexOf("kümede sadece"));
        expect(html.indexOf("kümede sadece")).toBeLessThan(html.indexOf("<h1"));
      });
    });
  });
});

describe("renderEmbedHtml", () => {
  const html = renderEmbedHtml(buildEmbedModel(detail({ sourceCount: 12 }), ORIGIN));

  it("is a complete Turkish HTML5 document", () => {
    expect(html.startsWith("<!doctype html><html lang=\"tr\">")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("contains no script and loads no external resource", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<(link|img|iframe|object|embed|video|audio|source|base|form|input)\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    // the only absolute URL is the single outbound link
    const urls = html.match(/https?:\/\/[^"'\s<)]+/g) ?? [];
    expect(urls).toHaveLength(1);
    expect(urls[0]!.startsWith(`${ORIGIN}/cluster/${ID}?`)).toBe(true);
  });

  it("ships the light and dark themes, the zone colours and the no-scroll rules", () => {
    for (const token of ["#18181b", "#52525b", "#ffffff", "#e4e4e7", "#fafafa", "#a1a1aa", "#0a0a0a", "#ef4444", "#10b981"]) {
      expect(html).toContain(token);
    }
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("overflow:hidden");
    expect(html).toMatch(/body\{[^}]*margin:0/);
    expect(html).toMatch(/line-clamp:2/);
    // short frames (oEmbed allows maxheight down to 120) drop the brand line
    expect(html).toContain("@media (max-height:187px){.b{display:none}");
    expect(html).toContain("system-ui");
    // never a fixed pixel width that could force a horizontal scrollbar at 320
    // (`max-width:260px` in the media query is a condition, not a width)
    expect(html).not.toMatch(/(?<![-\w])width:\s*\d{3,}px/);
    expect(html).not.toMatch(/min-width:\s*\d{3,}px/);
  });

  describe("layout inside the documented 120px minimum envelope", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const rule = (selector: string) => style.match(new RegExp(`(?:^|\\})${selector.replace(".", "\\.")}\\{([^}]*)\\}`))?.[1] ?? "";

    it("clamps the title and the legend to one line in short frames", () => {
      const start = style.indexOf("@media (max-height:187px){");
      expect(start).toBeGreaterThan(-1);
      const block = style.slice(start, style.indexOf("@media (max-width:260px){"));
      expect(block).toContain("h1{font-size:15px;min-height:1.25em;-webkit-line-clamp:1;line-clamp:1}");
      expect(block).toContain(".l{-webkit-line-clamp:1;line-clamp:1}");
    });

    // Full layout, worst case (320x200 with ribbon and a two-line legend): ~188px
    // (see the budget comment in embed-html.ts). Any frame shorter than that
    // must take the compact block, because in the full layout the title is a
    // shrinkable flex item and the container squeezes it to a fractional line
    // count that overflow:hidden then cuts mid-glyph. Verified by rendering in
    // headless Chrome: the old 160px breakpoint clipped the title's second
    // line at 320x168..186 (ribbon) and 320x161..163 (no ribbon).
    it("takes the compact block for every height the full layout cannot hold (oEmbed default 200 stays full)", () => {
      const breakpoint = Number(style.match(/@media \(max-height:(\d+)px\)\{/)?.[1]);
      expect(Number.isInteger(breakpoint)).toBe(true);
      for (const height of [120, 160, 161, 168, 170, 180, 186, 187]) {
        expect(height, `a ${height}px-tall frame must get the compact layout`).toBeLessThanOrEqual(breakpoint);
      }
      // 188px is the full layout's worst-case need, and the default oEmbed
      // height (200) must keep the brand line and the two-line title.
      for (const height of [188, 200, 240]) {
        expect(height, `a ${height}px-tall frame keeps the full layout`).toBeGreaterThan(breakpoint);
      }
    });

    // Measured in headless Chrome: a qualified legend 'N kaynak (M sınıflandırılmış)'
    // with up to 3-digit N/M wraps to 3 lines in the full layout below 253px, and
    // with a ribbon it squeezed the h1 to 1.27-1.84 lines at 241-252 x 188-200
    // (overflow:hidden then cut the second line mid-glyph). The narrow layout
    // (3-line legend clamp budgeted, ~167px) must therefore cover up to 260px.
    it("takes the narrow block for every width where the qualified legend wraps to 3 lines", () => {
      const breakpoint = Number(style.match(/@media \(max-width:(\d+)px\)\{/)?.[1]);
      expect(Number.isInteger(breakpoint)).toBe(true);
      for (const width of [241, 245, 248, 250, 252, 253, 260]) {
        expect(width, `a ${width}px-wide frame must get the narrow layout`).toBeLessThanOrEqual(breakpoint);
      }
      for (const width of [261, 320, 560]) {
        expect(width, `a ${width}px-wide frame keeps the full layout`).toBeGreaterThan(breakpoint);
      }
    });

    it("tightens padding and drops the brand line in narrow frames, after the short-frame block", () => {
      const heightAt = style.indexOf("@media (max-height:187px){");
      const widthAt = style.indexOf("@media (max-width:260px){");
      expect(heightAt).toBeGreaterThan(-1);
      expect(widthAt).toBeGreaterThan(heightAt);
      const block = style.slice(widthAt);
      expect(block).toContain(".b{display:none}");
      expect(block).toContain(".c{padding:8px 10px;gap:4px}");
      expect(block).toContain("h1{font-size:15px}");
    });

    it("never wraps or overflows the link", () => {
      const a = rule(".a");
      expect(a).toContain("white-space:nowrap");
      expect(a).toContain("overflow:hidden");
      expect(a).toContain("text-overflow:ellipsis");
      expect(a).toContain("max-width:100%");
    });

    it("never wraps the ribbon", () => {
      const r = rule(".r");
      expect(r).toContain("white-space:nowrap");
      expect(r).toContain("text-overflow:ellipsis");
    });

    it("caps the legend at three lines", () => {
      const l = rule(".l");
      expect(l).toContain("overflow:hidden");
      expect(l).toContain("display:-webkit-box");
      expect(l).toContain("-webkit-line-clamp:3");
      expect(l).toContain("line-clamp:3");
    });
  });

  it("renders the body parts in order: brand, h1, bar, legend, link", () => {
    const order = [
      "TAYF · Aynı haber, farklı dünyalar",
      "<h1",
      'role="img"',
      "İktidar %50 · Bağımsız %25 · Muhalefet %25 · 12 kaynak",
      "tayfhaber.com'da oku →",
    ].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("describes the bar for assistive tech and sizes the three segments", () => {
    expect(html).toContain('role="img" aria-label="İktidar %50, Bağımsız %25, Muhalefet %25"');
    expect(html).toContain("width:50%");
    expect(html.match(/width:25%/g)).toHaveLength(2);
  });

  it("opens the link in a new tab with rel=noopener", () => {
    const a = html.match(/<a [^>]*>/)![0];
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener"');
    expect(a).toContain(
      'href="https://tayf.test/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster"',
    );
  });

  // h60-newtab-1 (WCAG G201): the link opens a new tab, and a framed document
  // has no React and no shared component, so the hint is a literal span. The
  // `.v` rule hides it visually without display:none (which would also hide it
  // from a screen reader).
  it("ends the new-tab link's accessible name with a visually hidden notice", () => {
    expect(html).toMatch(
      /<a [^>]*target="_blank"[^>]*>tayfhaber\.com'da oku →<span class="v"> \(yeni sekmede açılır\)<\/span><\/a>/,
    );
  });

  it("styles .v as visually hidden: absolute, 1px, clipped, never display:none", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const v = style.match(/(?:^|\})\.v\{([^}]*)\}/)?.[1] ?? "";
    for (const decl of [
      "position:absolute",
      "width:1px",
      "height:1px",
      "overflow:hidden",
      "clip:rect(0,0,0,0)",
      "white-space:nowrap",
    ]) {
      expect(v, decl).toContain(decl);
    }
    expect(v).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("has no ribbon unless the model carries one", () => {
    expect(html).not.toContain("Kör nokta");
    const withRibbon = renderEmbedHtml(
      buildEmbedModel(
        detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: dist({ pro_government: 3 }) }),
        ORIGIN,
      ),
    );
    expect(withRibbon).toContain("Kör nokta: sadece iktidar yazdı");
    // ribbon sits between the brand line and the headline
    expect(withRibbon.indexOf("TAYF ·")).toBeLessThan(withRibbon.indexOf("Kör nokta"));
    expect(withRibbon.indexOf("Kör nokta")).toBeLessThan(withRibbon.indexOf("<h1"));
  });

  it("explains an empty distribution instead of printing 0% three times", () => {
    const empty = renderEmbedHtml(buildEmbedModel(detail({ distribution: dist(), sourceCount: 3 }), ORIGIN));
    expect(empty).toContain("Bu haberde henüz sınıflandırılmış kaynak yok · 3 kaynak");
    expect(empty).not.toContain("İktidar %0 ·");
  });

  // h70-embed-3 (merged with h70-embed-4): the legend already says there is no
  // classified source, but the bar's aria-label used to read 'İktidar %0,
  // Bağımsız %0, Muhalefet %0' to a screen reader next to it.
  describe("bar aria-label with no classified source (h70-embed-3)", () => {
    const emptyHtml = renderEmbedHtml(buildEmbedModel(detail({ distribution: dist(), sourceCount: 2 }), ORIGIN));
    const ariaOf = (doc: string) => /<div class="bar" role="img" aria-label="([^"]*)">/.exec(doc)?.[1];

    it("labels the bar exactly 'Sınıflandırılmış kaynak yok' when every zone count is 0", () => {
      expect(emptyHtml).toContain('<div class="bar" role="img" aria-label="Sınıflandırılmış kaynak yok">');
      expect(ariaOf(emptyHtml)).toBe("Sınıflandırılmış kaynak yok");
    });

    it("never reads a percent to assistive tech for an empty distribution", () => {
      expect(ariaOf(emptyHtml)).not.toContain("%");
      expect(emptyHtml).not.toContain("İktidar %0, Bağımsız %0, Muhalefet %0");
    });

    it("keeps the visible legend sentence unchanged", () => {
      expect(emptyHtml).toContain('<p class="l">Bu haberde henüz sınıflandırılmış kaynak yok · 2 kaynak</p>');
    });

    it("keeps the three zone-list label for a classified cluster (percentages stay)", () => {
      const classified = renderEmbedHtml(buildEmbedModel(detail({ sourceCount: 12 }), ORIGIN));
      expect(ariaOf(classified)).toBe("İktidar %50, Bağımsız %25, Muhalefet %25");
    });

    it("keeps the zone list when a single zone is classified (total 1, other zones 0)", () => {
      const one = renderEmbedHtml(buildEmbedModel(detail({ distribution: dist({ opposition: 1 }) }), ORIGIN));
      expect(ariaOf(one)).toBe("İktidar %0, Bağımsız %0, Muhalefet %100");
    });

    it("decides on the model's total, not on the percents", () => {
      const m = buildEmbedModel(detail({}), ORIGIN);
      const zeroTotal = renderEmbedHtml({ ...m, total: 0 });
      expect(ariaOf(zeroTotal)).toBe("Sınıflandırılmış kaynak yok");
    });
  });

  // h70-embed-3: in Windows High Contrast (forced-colors) the UA repaints every
  // background-color to Canvas, which erased the three segments and the ribbon.
  describe("forced-colors (Windows High Contrast) support (h70-embed-3)", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const FORCED_RULE =
      "@media (forced-colors: active){.bar,.bar span,.r{forced-color-adjust:none}.bar{border:1px solid CanvasText}}";

    it("ships a forced-colors media query that opts the bar, its segments and the ribbon out of the repaint", () => {
      expect(html).toContain("@media (forced-colors: active)");
      expect(html).toContain("forced-color-adjust:none");
      expect(style).toContain(FORCED_RULE);
    });

    it("draws a system-colour outline around the bar so it stays visible", () => {
      expect(style).toContain(".bar{border:1px solid CanvasText}");
    });

    it("comes after the two layout media queries (the layout blocks stay untouched)", () => {
      const heightAt = style.indexOf("@media (max-height:187px){");
      const widthAt = style.indexOf("@media (max-width:260px){");
      const forcedAt = style.indexOf("@media (forced-colors: active)");
      expect(widthAt).toBeGreaterThan(heightAt);
      expect(forcedAt).toBeGreaterThan(widthAt);
      // the narrow block still ends right before the forced-colors block
      expect(style.slice(widthAt, forcedAt)).toBe("@media (max-width:260px){.b{display:none}.c{padding:8px 10px;gap:4px}h1{font-size:15px}}");
    });

    it("keeps the three segment colours and adds no script or external resource", () => {
      expect(style).toContain(".zi{background:#ef4444}.zb{background:#a1a1aa}.zm{background:#10b981}");
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/url\(/i);
    });

    it("does not change the 10px bar height (border-box keeps the border inside it)", () => {
      expect(style).toMatch(/(?:^|\})\*\{box-sizing:border-box\}/);
      expect(style).toMatch(/(?:^|\})\.bar\{[^}]*height:10px/);
      // the forced-colors rule must not set a height or a margin on the bar
      const forcedAt = style.indexOf("@media (forced-colors: active)");
      expect(forcedAt).toBeGreaterThan(-1);
      expect(style.slice(forcedAt)).not.toMatch(/height|margin|padding/);
    });

    it("is shipped by the status document too (same STYLE)", () => {
      expect(renderEmbedMessageHtml("Haber bulunamadı")).toContain(FORCED_RULE);
    });
  });

  it("escapes a hostile title in both <title> and <h1>", () => {
    const evil = renderEmbedHtml(buildEmbedModel(detail({ title: '"><script>alert(1)</script>' }), ORIGIN));
    expect(evil).not.toMatch(/<script/i);
    expect(evil).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(evil.match(/&quot;&gt;&lt;script&gt;/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("escapes an hostile origin in the link", () => {
    const evil = renderEmbedHtml(buildEmbedModel(detail({}), 'https://x.test/"><script>alert(1)</script>'));
    expect(evil).not.toMatch(/<script/i);
  });

  it("escapes a hostile ribbon/legend value coming through the model", () => {
    const m = buildEmbedModel(detail({}), ORIGIN);
    const evil = renderEmbedHtml({ ...m, ribbon: "<img src=x onerror=alert(1)>" });
    expect(evil).not.toContain("<img");
    expect(evil).toContain("&lt;img");
  });

  it("is deterministic", () => {
    const m = buildEmbedModel(detail({}), ORIGIN);
    expect(renderEmbedHtml(m)).toBe(renderEmbedHtml(m));
  });
});

// h44-consistency-1: the zone percents are computed over the classified
// (voting) sources only, so a legend that prints the full member count next to
// them must say so, in the wording the share text / RSS / Telegram use
// (sourceCountHead): 'N kaynak (M sınıflandırılmış)'.
describe("renderEmbedHtml legend basis (h44-consistency-1)", () => {
  function legendFor(over: Parameters<typeof detail>[0]): string {
    const html = renderEmbedHtml(buildEmbedModel(detail(over), ORIGIN));
    const m = html.match(/<p class="l">([^<]*)<\/p>/);
    expect(m).not.toBeNull();
    return m![1]!;
  }

  it("names the classified basis when only 9 of 10 members vote (prod b34a5fe0: 1/4/4)", () => {
    const legend = legendFor({
      sourceCount: 10,
      distribution: dist({ pro_government: 1, center: 4, opposition: 4 }),
    });
    expect(legend).toBe("İktidar %11 · Bağımsız %45 · Muhalefet %44 · 10 kaynak (9 sınıflandırılmış)");
  });

  it("is byte-identical to the old legend when every member is classified", () => {
    const legend = legendFor({
      sourceCount: 10,
      distribution: dist({ pro_government: 5, center: 3, opposition: 2 }),
    });
    expect(legend).toBe("İktidar %50 · Bağımsız %30 · Muhalefet %20 · 10 kaynak");
    expect(legend).not.toContain("sınıflandırılmış)");
  });

  it("keeps the bare count when a stale tally exceeds the member count", () => {
    const legend = legendFor({
      sourceCount: 3,
      distribution: dist({ pro_government: 2, center: 1, opposition: 1 }),
    });
    expect(legend).toBe("İktidar %50 · Bağımsız %25 · Muhalefet %25 · 3 kaynak");
  });

  it("leaves the empty-distribution sentence unchanged", () => {
    const legend = legendFor({ distribution: dist(), sourceCount: 2 });
    expect(legend).toBe("Bu haberde henüz sınıflandırılmış kaynak yok · 2 kaynak");
  });

  it("uses the shared helper's wording (same string as the share text / RSS head)", async () => {
    const { sourceCountHead } = await import("@/lib/feeds/zone-line");
    const head = sourceCountHead(10, { iktidar: 1, bagimsiz: 4, muhalefet: 4 });
    const legend = legendFor({
      sourceCount: 10,
      distribution: dist({ pro_government: 1, center: 4, opposition: 4 }),
    });
    expect(legend.endsWith(` · ${head}`)).toBe(true);
  });
});

describe("renderEmbedMessageHtml", () => {
  const html = renderEmbedMessageHtml("Haber bulunamadı");

  it("is a noindex, script-less shell carrying the message", () => {
    expect(html.startsWith('<!doctype html><html lang="tr">')).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain("Haber bulunamadı");
    expect(html).not.toMatch(/<script|<a |<img|<link/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("ships the same layout STYLE as the widget document", () => {
    const style = (doc: string) => doc.match(/<style>([\s\S]*?)<\/style>/)![1];
    const widget = renderEmbedHtml(buildEmbedModel(detail({}), ORIGIN));
    expect(style(html)).toBeTruthy();
    expect(style(html)).toBe(style(widget));
  });

  it("escapes the message", () => {
    const evil = renderEmbedMessageHtml("<script>alert(1)</script>");
    expect(evil).not.toMatch(/<script/i);
    expect(evil).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// h118-shares-1: an all-English cluster (92742df8: daily-sabah, hurriyet-daily-news,
// trt-world, 3 sources, pro_government 2 / gov_leaning 1) embedded as a bare
// <h1>Türkiye remembers Atatürk ...</h1> over "İktidar %100 · Bağımsız %0 ·
// Muhalefet %0 · 3 kaynak", the zone-absence claim its own page does not make, and
// the English headline had no lang="en". The qualifier is the page's; the bar stays.
// ---------------------------------------------------------------------------
describe("embed of an all-English cluster (h118-shares-1)", () => {
  const CLAUSE = "Yalnızca İngilizce kaynaklar, Türkçe haberlerle karşılaştırılmadı";
  const ARIA = "Yalnızca İngilizce kaynaklar; Türkçe haberlerle karşılaştırılmadı";

  // Mirrors 92742df8: the headline is the trt-world member's own title.
  const TRT = memberOf("trt-world", "outlet", "pro_government");
  const ISO_TITLE = TRT.article.title;
  const ISO_MEMBERS = [
    memberOf("daily-sabah", "outlet", "pro_government"),
    memberOf("hurriyet-daily-news", "outlet", "gov_leaning"),
    TRT,
  ];
  const ISO_DIST = dist({ pro_government: 2, gov_leaning: 1 });
  // Mirrors 2dab7e87.
  const ISO2_MEMBERS = [memberOf("a-news", "outlet", "pro_government"), memberOf("trt-world", "outlet", "pro_government")];
  const withTitle = (m: ClusterDetailMember, title: string): ClusterDetailMember => ({
    ...m,
    article: { ...m.article, title },
  });

  const iso = (over: Parameters<typeof detail>[0] = {}) =>
    detail({
      title: ISO_TITLE,
      titleMethod: "extractive",
      distribution: ISO_DIST,
      sourceCount: 3,
      members: ISO_MEMBERS,
      ...over,
    });
  const htmlOf = (d: ClusterDetail) => renderEmbedHtml(buildEmbedModel(d, ORIGIN));
  const legendOfHtml = (html: string) => html.match(/<p class="l">([^<]*)<\/p>/)![1]!;
  const ariaOfHtml = (html: string) => html.match(/role="img" aria-label="([^"]*)"/)![1]!;
  const h1OfHtml = (html: string) => html.match(/<h1[^>]*>[^<]*<\/h1>/)![0];

  describe("buildEmbedModel", () => {
    it("flags the cluster isolated and marks its extractive English headline 'en'", () => {
      const m = buildEmbedModel(iso(), ORIGIN);
      expect(m.languageIsolated).toBe(true);
      expect(m.headlineLang).toBe("en");
    });

    it("2dab7e87: a-news + trt-world is isolated too", () => {
      const m = buildEmbedModel(
        detail({ title: "Erdogan, Guterres discuss regional issues", titleMethod: "extractive", distribution: dist({ pro_government: 2 }), sourceCount: 2, members: ISO2_MEMBERS }),
        ORIGIN,
      );
      expect(m.languageIsolated).toBe(true);
      expect(m.headlineLang).toBe("en");
    });

    it("title_method null (a pre-method row) counts as the member's own title: 'en'", () => {
      expect(buildEmbedModel(iso({ titleMethod: null }), ORIGIN).headlineLang).toBe("en");
    });

    it("the LLM rewrite is Turkish text: no headline lang, but the cluster is still isolated", () => {
      const m = buildEmbedModel(iso({ titleMethod: "llm" }), ORIGIN);
      expect(m.headlineLang).toBeUndefined();
      expect(m.languageIsolated).toBe(true);
    });

    it("the KVKK generic fallback is not the cluster's own title: no headline lang", () => {
      const m = buildEmbedModel(iso({ title: "17 yaşındaki genç tutuklandı" }), ORIGIN);
      expect(m.title).toBe(EMBED_GENERIC_TITLE);
      expect(m.headlineLang).toBeUndefined();
      expect(m.languageIsolated).toBe(true);
    });

    it("a contentless title shown as 'Haber' is not English text either", () => {
      const m = buildEmbedModel(iso({ title: "&nbsp" }), ORIGIN);
      expect(m.title).toBe(NO_HEADLINE_TITLE);
      expect(m.headlineLang).toBeUndefined();
    });

    it("an empty title falls back to the generic heading: no headline lang", () => {
      const m = buildEmbedModel(iso({ title: "   " }), ORIGIN);
      expect(m.title).toBe(EMBED_GENERIC_TITLE);
      expect(m.headlineLang).toBeUndefined();
    });

    it("decides on the FULL stored title, not the truncated model title", () => {
      // The English headline is longer than EMBED_TITLE_MAX: the model title is cut with an
      // ellipsis, and only the full stored title equals the English member's own.
      const long = `${"Turkish president Erdogan and UN chief Guterres discuss regional and global issues ".repeat(3)}at COP31`;
      expect(long.length).toBeGreaterThan(EMBED_TITLE_MAX);
      const mixed = [
        withTitle(memberOf("a-haber", "outlet", "pro_government"), "Türkçe bir başlık"),
        withTitle(memberOf("daily-sabah", "outlet", "pro_government"), long),
      ];
      const m = buildEmbedModel(
        detail({ title: long, titleMethod: "extractive", distribution: dist({ pro_government: 2 }), sourceCount: 2, members: mixed }),
        ORIGIN,
      );
      expect(m.title.endsWith("…")).toBe(true);
      expect(m.languageIsolated).toBe(false);
      expect(m.headlineLang).toBe("en");
    });

    it("a mixed cluster whose headline is an English member's own title takes the page's rule: 'en', not isolated", () => {
      const tr = memberOf("a-haber", "outlet", "pro_government");
      const en = memberOf("daily-sabah", "outlet", "pro_government");
      const m = buildEmbedModel(
        detail({ title: en.article.title, titleMethod: "extractive", distribution: dist({ pro_government: 2 }), sourceCount: 2, members: [tr, en] }),
        ORIGIN,
      );
      expect(m.languageIsolated).toBe(false);
      expect(m.headlineLang).toBe("en");
    });

    it("a mixed cluster with a Turkish headline: no headline lang, not isolated", () => {
      const m = buildEmbedModel(
        detail({
          distribution: dist({ pro_government: 2 }),
          sourceCount: 2,
          members: [memberOf("a-haber", "outlet", "pro_government"), memberOf("daily-sabah", "outlet", "pro_government")],
        }),
        ORIGIN,
      );
      expect(m.languageIsolated).toBe(false);
      expect(m.headlineLang).toBeUndefined();
    });

    it("a detail with no members is neither isolated nor English", () => {
      const m = buildEmbedModel(detail({}), ORIGIN);
      expect(m.languageIsolated).toBe(false);
      expect(m.headlineLang).toBeUndefined();
    });
  });

  describe("renderEmbedHtml", () => {
    it('92742df8: <h1 lang="en"> over the new legend and aria-label, with the bar and the Turkish document language kept', () => {
      const html = htmlOf(iso());
      expect(h1OfHtml(html)).toBe(`<h1 lang="en">${escapeHtml(ISO_TITLE)}</h1>`);
      expect(legendOfHtml(html)).toBe(`${CLAUSE} · 3 kaynak`);
      expect(ariaOfHtml(html)).toBe(ARIA);
      // The bar is the cluster's own and stays.
      expect(html).toContain('<span class="zi" style="width:100%"></span>');
      // The legend and the link are Turkish: the document language does not change.
      expect(html.startsWith('<!doctype html><html lang="tr">')).toBe(true);
      expect(html).not.toContain("İktidar %");
      expect(html).not.toContain("Bağımsız %");
    });

    it("the lang attribute sits on the <h1> only", () => {
      expect(htmlOf(iso()).match(/lang="en"/g)).toHaveLength(1);
    });

    it("2dab7e87: two sources", () => {
      const html = htmlOf(
        detail({ title: "Erdogan, Guterres discuss regional issues", titleMethod: "extractive", distribution: dist({ pro_government: 2 }), sourceCount: 2, members: ISO2_MEMBERS }),
      );
      expect(legendOfHtml(html)).toBe(`${CLAUSE} · 2 kaynak`);
      expect(h1OfHtml(html)).toBe('<h1 lang="en">Erdogan, Guterres discuss regional issues</h1>');
    });

    it("the legend keeps the classified-basis head when fewer sources voted than wrote", () => {
      const html = htmlOf(iso({ sourceCount: 4 }));
      expect(legendOfHtml(html)).toBe(`${CLAUSE} · 4 kaynak (3 sınıflandırılmış)`);
    });

    it("title_method 'llm' gives a bare <h1> (the rewrite is Turkish) under the same legend", () => {
      const html = htmlOf(iso({ title: "Atatürk 88. ölüm yıl dönümünde anıldı", titleMethod: "llm" }));
      expect(h1OfHtml(html)).toBe("<h1>Atatürk 88. ölüm yıl dönümünde anıldı</h1>");
      expect(legendOfHtml(html)).toBe(`${CLAUSE} · 3 kaynak`);
    });

    it("the generic fallback gives a bare <h1>", () => {
      expect(h1OfHtml(htmlOf(iso({ title: "SANIK hakkında karar" })))).toBe(`<h1>${EMBED_GENERIC_TITLE}</h1>`);
    });

    it("the contentless 'Haber' gives a bare <h1>", () => {
      expect(h1OfHtml(htmlOf(iso({ title: "&nbsp" })))).toBe("<h1>Haber</h1>");
    });

    it("escapes the English headline inside the lang-tagged <h1>", () => {
      const html = htmlOf(iso({ title: '"><script>alert(1)</script>' }));
      expect(html).not.toMatch(/<script/i);
      expect(h1OfHtml(html).startsWith('<h1 lang="en">')).toBe(true);
    });

    it("never prints a percent in the legend, and the layout block is untouched", () => {
      const html = htmlOf(iso());
      expect(legendOfHtml(html)).not.toContain("%");
      const style = (doc: string) => doc.match(/<style>([\s\S]*?)<\/style>/)![1];
      expect(style(html)).toBe(style(htmlOf(detail({}))));
    });

    it("an isolated cluster with nothing voting keeps its 'henüz sınıflandırılmış kaynak yok' legend, and the aria-label names the qualifier", () => {
      const html = htmlOf(
        iso({
          distribution: dist(),
          sourceCount: 2,
          members: [memberOf("mfa-turkey", "niche", "center"), memberOf("a-news", "niche", "center")],
        }),
      );
      expect(legendOfHtml(html)).toBe("Bu haberde henüz sınıflandırılmış kaynak yok · 2 kaynak");
      expect(ariaOfHtml(html)).toBe(ARIA);
    });

    it("a flagged isolated cluster's ribbon reads 'kümede sadece iktidar', never 'sadece iktidar yazdı'", () => {
      const html = htmlOf(
        iso({ distribution: dist({ pro_government: 3 }), isBlindspot: true, blindspotSide: "pro_government" }),
      );
      expect(html).toContain('<div class="r">Kör nokta: kümede sadece iktidar</div>');
      expect(html).not.toContain("yazdı");
    });

    it("a flagged isolated cluster with a toplayıcı / niş source in another zone keeps 'spektrumda sadece'", () => {
      const html = htmlOf(
        iso({
          distribution: dist({ pro_government: 2 }),
          isBlindspot: true,
          blindspotSide: "pro_government",
          members: [
            memberOf("daily-sabah", "outlet", "pro_government"),
            memberOf("trt-world", "outlet", "pro_government"),
            memberOf("mfa-turkey", "niche", "opposition"),
          ],
        }),
      );
      expect(html).toContain('<div class="r">Kör nokta: spektrumda sadece iktidar</div>');
    });
  });

  // The controls: HTML captured from the code as it was BEFORE h118-shares-1
  // (6c49f9c), with the shared <style> block elided. They must stay byte-identical.
  describe("controls stay byte-identical", () => {
    const withoutStyle = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "<style>STYLE</style>");
    const GOLDEN_TURKISH = "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Merkez Bankası faizi sabit tuttu · Tayf</title><style>STYLE</style></head><body><div class=\"c\"><div class=\"b\">TAYF · Aynı haber, farklı dünyalar</div><h1>Merkez Bankası faizi sabit tuttu</h1><div class=\"bar\" role=\"img\" aria-label=\"İktidar %100, Bağımsız %0, Muhalefet %0\"><span class=\"zi\" style=\"width:100%\"></span><span class=\"zb\" style=\"width:0%\"></span><span class=\"zm\" style=\"width:0%\"></span></div><p class=\"l\">İktidar %100 · Bağımsız %0 · Muhalefet %0 · 3 kaynak</p><a class=\"a\" href=\"https://tayf.test/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster\" target=\"_blank\" rel=\"noopener\">tayfhaber.com'da oku →<span class=\"v\"> (yeni sekmede açılır)</span></a></div></body></html>";
    const GOLDEN_MIXED = "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Merkez Bankası faizi sabit tuttu · Tayf</title><style>STYLE</style></head><body><div class=\"c\"><div class=\"b\">TAYF · Aynı haber, farklı dünyalar</div><h1>Merkez Bankası faizi sabit tuttu</h1><div class=\"bar\" role=\"img\" aria-label=\"İktidar %100, Bağımsız %0, Muhalefet %0\"><span class=\"zi\" style=\"width:100%\"></span><span class=\"zb\" style=\"width:0%\"></span><span class=\"zm\" style=\"width:0%\"></span></div><p class=\"l\">İktidar %100 · Bağımsız %0 · Muhalefet %0 · 2 kaynak</p><a class=\"a\" href=\"https://tayf.test/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster\" target=\"_blank\" rel=\"noopener\">tayfhaber.com'da oku →<span class=\"v\"> (yeni sekmede açılır)</span></a></div></body></html>";
    const GOLDEN_NON_VOTING = "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Merkez Bankası faizi sabit tuttu · Tayf</title><style>STYLE</style></head><body><div class=\"c\"><div class=\"b\">TAYF · Aynı haber, farklı dünyalar</div><h1>Merkez Bankası faizi sabit tuttu</h1><div class=\"bar\" role=\"img\" aria-label=\"Sınıflandırılmış kaynak yok\"><span class=\"zi\" style=\"width:0%\"></span><span class=\"zb\" style=\"width:0%\"></span><span class=\"zm\" style=\"width:0%\"></span></div><p class=\"l\">Bu haberde henüz sınıflandırılmış kaynak yok · 2 kaynak</p><a class=\"a\" href=\"https://tayf.test/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster\" target=\"_blank\" rel=\"noopener\">tayfhaber.com'da oku →<span class=\"v\"> (yeni sekmede açılır)</span></a></div></body></html>";
    const GOLDEN_RECALL = "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Merkez Bankası faizi sabit tuttu · Tayf</title><style>STYLE</style></head><body><div class=\"c\"><div class=\"b\">TAYF · Aynı haber, farklı dünyalar</div><div class=\"r\">Kör nokta: kümede sadece iktidar</div><h1>Merkez Bankası faizi sabit tuttu</h1><div class=\"bar\" role=\"img\" aria-label=\"İktidar %100, Bağımsız %0, Muhalefet %0\"><span class=\"zi\" style=\"width:100%\"></span><span class=\"zb\" style=\"width:0%\"></span><span class=\"zm\" style=\"width:0%\"></span></div><p class=\"l\">İktidar %100 · Bağımsız %0 · Muhalefet %0 · 9 kaynak</p><a class=\"a\" href=\"https://tayf.test/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster\" target=\"_blank\" rel=\"noopener\">tayfhaber.com'da oku →<span class=\"v\"> (yeni sekmede açılır)</span></a></div></body></html>";

    it("a Turkish 3-outlet 100% İktidar cluster", () => {
      const html = htmlOf(
        detail({
          distribution: dist({ pro_government: 3 }),
          sourceCount: 3,
          members: [
            memberOf("sabah", "outlet", "pro_government"),
            memberOf("yeni-safak", "outlet", "pro_government"),
            memberOf("a-haber", "outlet", "pro_government"),
          ],
        }),
      );
      expect(withoutStyle(html)).toBe(GOLDEN_TURKISH);
    });

    it("a mixed a-haber + daily-sabah cluster with a Turkish title", () => {
      const html = htmlOf(
        detail({
          distribution: dist({ pro_government: 2 }),
          sourceCount: 2,
          members: [memberOf("a-haber", "outlet", "pro_government"), memberOf("daily-sabah", "outlet", "pro_government")],
        }),
      );
      expect(withoutStyle(html)).toBe(GOLDEN_MIXED);
    });

    it("an all-zero non-voting cluster (the h64-ogcards-3 line)", () => {
      const html = htmlOf(
        detail({
          distribution: dist(),
          sourceCount: 2,
          members: [memberOf("haberler-com", "aggregator", "gov_leaning"), memberOf("ekonomim", "niche", "center")],
        }),
      );
      expect(withoutStyle(html)).toBe(GOLDEN_NON_VOTING);
    });

    it("a recall-matched blindspot (the h108 'kümede sadece')", () => {
      const html = htmlOf(
        detail({
          distribution: dist({ pro_government: 6, gov_leaning: 3 }),
          sourceCount: 9,
          isBlindspot: true,
          blindspotSide: "pro_government",
          members: [
            ...Array.from({ length: 6 }, (_, i) => memberOf(`outlet-${i}`, "outlet", "pro_government")),
            ...Array.from({ length: 3 }, (_, i) => memberOf(`leaning-${i}`, "outlet", "gov_leaning")),
          ],
          recallMatchedZones: ["muhalefet"],
        }),
      );
      expect(withoutStyle(html)).toBe(GOLDEN_RECALL);
    });
  });
});
