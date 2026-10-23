import { describe, it, expect } from "vitest";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";
import type { BiasCategory, BiasDistribution } from "@/types";
import {
  EMBED_GENERIC_TITLE,
  EMBED_TITLE_MAX,
  buildEmbedModel,
  renderEmbedHtml,
  renderEmbedMessageHtml,
  safeEmbedTitle,
} from "./embed-html";

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
}): ClusterDetail {
  return {
    cluster: {
      id: ID,
      title_tr: over.title ?? "Merkez Bankası faizi sabit tuttu",
      title_original: null,
      title_method: null,
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
    members: [],
    allSources: [],
    wire: { effectiveArticleCount: over.sourceCount ?? 4 } as ClusterDetail["wire"],
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

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
    // (`max-width:240px` in the media query is a condition, not a width)
    expect(html).not.toMatch(/(?<![-\w])width:\s*\d{3,}px/);
    expect(html).not.toMatch(/min-width:\s*\d{3,}px/);
  });

  describe("layout inside the documented 120px minimum envelope", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const rule = (selector: string) => style.match(new RegExp(`(?:^|\\})${selector.replace(".", "\\.")}\\{([^}]*)\\}`))?.[1] ?? "";

    it("clamps the title and the legend to one line in short frames", () => {
      const start = style.indexOf("@media (max-height:187px){");
      expect(start).toBeGreaterThan(-1);
      const block = style.slice(start, style.indexOf("@media (max-width:240px){"));
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

    it("tightens padding and drops the brand line in narrow frames, after the short-frame block", () => {
      const heightAt = style.indexOf("@media (max-height:187px){");
      const widthAt = style.indexOf("@media (max-width:240px){");
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
