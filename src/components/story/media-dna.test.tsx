import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaDna, mediaDnaChipClass } from "./media-dna";
import { ZONE_META } from "@/lib/bias/config";
import { SOURCE_KIND_META } from "@/lib/sources/kind";
import type { Source } from "@/types";

function source(overrides: Partial<Source>): Source {
  return {
    id: overrides.id ?? overrides.slug ?? "src",
    name: overrides.name ?? "Kaynak",
    slug: overrides.slug ?? "kaynak",
    url: "https://example.com",
    rss_url: "https://example.com/rss",
    bias: overrides.bias ?? "center",
    logo_url: null,
    active: true,
    trustee_since: null,
    trustee_note: null,
    ...overrides,
  };
}

describe("MediaDna screen-reader detail", () => {
  const outlet = source({ id: "1", slug: "outlet-a", name: "Outlet A", bias: "center", kind: "outlet" });
  const aggregator = source({ id: "2", slug: "agg-a", name: "Agg A", bias: "center", kind: "aggregator" });
  const highlightSlugs = new Set(["outlet-a", "agg-a"]);

  const html = renderToStaticMarkup(
    <MediaDna sources={[outlet, aggregator]} highlightSlugs={highlightSlugs} />,
  );

  it("gives the non-voting (aggregator) chip a sr-only note that it does not count toward the bias distribution", () => {
    expect(html).toContain("yanlılık dağılımına sayılmaz");
    // The sr-only note text sits right after the source name, inside a
    // class="sr-only" span, distinct from the always-visible title attribute.
    expect(html).toMatch(/class="sr-only"[^>]*>[^<]*yanlılık dağılımına sayılmaz/);
  });

  it("gives the voting (outlet) chip its bias label in sr-only text, without the non-voting note", () => {
    // Extract the sr-only span that immediately follows "Outlet A".
    const idx = html.indexOf("Outlet A");
    expect(idx).toBeGreaterThan(-1);
    const after = html.slice(idx, idx + 400);
    const srMatch = after.match(/class="sr-only"[^>]*>([^<]*)</);
    expect(srMatch).toBeTruthy();
    expect(srMatch![1]).not.toContain("yanlılık dağılımına sayılmaz");
  });
});

// WCAG 1.4.3: chips and their kind labels used to be faded with opacity-50 /
// opacity-30 / opacity-70, which measures 2.0-3.25:1. Non-voting chips are now
// told apart by a dashed border, expanded-mode non-participants by dropping
// the tint, and nothing carries an opacity utility any more.
describe("mediaDnaChipClass (no opacity fading)", () => {
  const meta = ZONE_META.bagimsiz;
  // A bare opacity-NN / opacity-[x] utility; variant forms (hover:, disabled:,
  // group-hover/x:) are not text fading and are skipped, like the guard test.
  const BARE_OPACITY = /(?<![\w:\/-])opacity-/;

  it("voting + highlighted: zone tint, text and border, solid border", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: true, isHighlighted: true });
    expect(cls).toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
    expect(cls).toContain(meta.chipBorder);
    expect(cls).not.toContain("border-dashed");
  });

  it("non-voting + highlighted: zone tint and full-strength text on a dashed border", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: false, isHighlighted: true });
    expect(cls).toContain("border-dashed");
    expect(cls).toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
  });

  it("voting + not highlighted: tint dropped, text and border kept", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: true, isHighlighted: false });
    expect(cls).toContain("bg-transparent");
    expect(cls).not.toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
    expect(cls).toContain(meta.chipBorder);
    expect(cls).not.toContain("border-dashed");
  });

  it("non-voting + not highlighted: dashed border and no tint", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: false, isHighlighted: false });
    expect(cls).toContain("border-dashed");
    expect(cls).toContain("bg-transparent");
    expect(cls).not.toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
  });

  it("never carries an opacity utility, in any combination or zone", () => {
    for (const zoneMeta of Object.values(ZONE_META)) {
      for (const isVoting of [true, false]) {
        for (const isHighlighted of [true, false]) {
          const cls = mediaDnaChipClass(zoneMeta, { isVoting, isHighlighted });
          expect(cls).not.toMatch(BARE_OPACITY);
          expect(cls).not.toContain("transition-opacity");
        }
      }
    }
  });
});

describe("MediaDna collapsed render (contrast + zone count)", () => {
  const gov = source({ id: "g", slug: "gov", name: "Gov Outlet", bias: "pro_government", kind: "outlet" });
  const mid = source({ id: "c", slug: "mid", name: "Mid Outlet", bias: "center", kind: "outlet" });
  const opp = source({ id: "o", slug: "opp", name: "Opp Outlet", bias: "opposition", kind: "outlet" });
  const agg = source({ id: "a", slug: "agg", name: "Agg Outlet", bias: "center", kind: "aggregator" });
  const html = renderToStaticMarkup(
    <MediaDna
      sources={[gov, mid, opp, agg]}
      highlightSlugs={new Set(["gov", "mid", "opp", "agg"])}
    />,
  );

  it("carries no opacity-NN utility anywhere in the markup", () => {
    expect(html).not.toMatch(/opacity-\d/);
  });

  it("gives the non-voting (aggregator) chip a dashed border", () => {
    const m = html.match(/<span title="Agg Outlet[^"]*" class="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("border-dashed");
    // A voting chip next to it keeps the solid border.
    const voting = html.match(/<span title="Mid Outlet[^"]*" class="([^"]*)"/);
    expect(voting).toBeTruthy();
    expect(voting![1]).not.toContain("border-dashed");
  });

  it("renders the kind label at 10px with no opacity", () => {
    const label = SOURCE_KIND_META.aggregator.label;
    const m = html.match(new RegExp(`<span class="([^"]*)">${label}</span>`));
    expect(m).toBeTruthy();
    expect(m![1]).toBe("ml-0.5 text-[10px] uppercase tracking-wider");
  });

  it("explains non-voting chips with the dashed-border legend, not the old 'Soluk' copy", () => {
    expect(html).toContain(
      "Kesikli çerçeveyle gösterilen toplayıcı / niş kaynaklar kümelerde listelenir ama yanlılık dağılımına sayılmaz.",
    );
    expect(html).not.toContain("Soluk");
  });

  it("renders each zone's 'N kaynak' count as ONE text node in the zone label colour", () => {
    const matches = [...html.matchAll(/<span class="([^"]*)">(\d+) kaynak<\/span>/g)];
    // muhalefet, bagimsiz, iktidar (ZONE_ORDER).
    expect(matches).toHaveLength(3);
    const zones = ["muhalefet", "bagimsiz", "iktidar"] as const;
    zones.forEach((zone, i) => {
      const [, cls] = matches[i]!;
      expect(cls).toContain(ZONE_META[zone].zoneLabel);
      expect(cls).toContain("text-[10px]");
      expect(cls).not.toContain("text-muted-foreground");
    });
    // Count semantics unchanged: members in the current (collapsed) view.
    expect(matches.map((m) => m[2])).toEqual(["1", "2", "1"]);
  });
});
