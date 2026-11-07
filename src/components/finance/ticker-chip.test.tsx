import Link from "next/link";
import { describe, expect, it } from "vitest";
import { TickerChip, TickerTape } from "./ticker-chip";
import type { Quote } from "@/lib/finance/quotes";
import type { QuoteStat, TickerAttention } from "@/lib/finance/queries";
import { rebaseQuoteOnStat } from "@/lib/finance/session";

// Walks the element tree the way label-card.test.tsx and framing-game.test.tsx
// do, since vitest runs in a plain node environment (no jsdom/RTL).
type Node = { type: unknown; props: Record<string, unknown> };

function collect(node: unknown, out: Node[] = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props !== undefined) {
    out.push({ type: el.type, props: el.props });
    collect(el.props.children, out);
  }
  return out;
}

/** Plain text of a subtree (strings and numbers only), concatenated. */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: unknown } };
  return textOf(el.props?.children);
}

const spans = (nodes: Node[]) => nodes.filter((n) => n.type === "span");
const classOf = (n: Node) => String(n.props.className ?? "");

const quote: Quote = {
  ticker: "OZATD",
  price: 1935,
  prevClose: 2150,
  changePct: -10,
  hasBaseline: true,
  closes: [2150, 1935],
  currency: "TRY",
  asOf: "2026-10-30T15:00:00.000Z",
};

describe("TickerChip", () => {
  it("wraps instead of forcing nowrap on the whole chip, with inner spans kept nowrap", () => {
    const el = TickerChip({ ticker: "OZATD", quote, sinceNews: -3 });
    const nodes = collect(el);
    const root = nodes[0]!;
    const rootClass = String(root.props.className ?? "");
    expect(rootClass).toContain("flex-wrap");
    expect(rootClass).toContain("max-w-full");
    expect(rootClass).toContain("min-w-0");
    expect(rootClass).not.toContain("whitespace-nowrap");

    const nowrapSpans = nodes.filter(
      (n) => n.type === "span" && String(n.props.className ?? "").includes("whitespace-nowrap"),
    );
    expect(nowrapSpans.length).toBeGreaterThanOrEqual(4);

    const haberdenSpan = nodes.find(
      (n) => n.type === "span" && collect(n.props.children).length === 0 && n.props.children === "haberden",
    );
    expect(haberdenSpan).toBeDefined();
    const haberdenClass = String(haberdenSpan!.props.className ?? "");
    expect(haberdenClass).toContain("hidden");
    expect(haberdenClass).toContain("sm:inline");
  });

  it("renders the signed move and the taban flag for a known move", () => {
    const text = textOf(TickerChip({ ticker: "OZATD", quote }));
    expect(text).toContain("-%10,00");
    expect(text).toContain("taban");
    expect(text).not.toContain("—");
  });

  it("renders '—' with no percent and no limit flag when hasBaseline is false", () => {
    const el = TickerChip({ ticker: "OZATD", quote: { ...quote, hasBaseline: false } });
    const text = textOf(el);
    expect(text).toContain("—");
    expect(text).not.toContain("%");
    expect(text).not.toContain("taban");
    expect(text).not.toContain("tavan");
    // The price is still shown: only the move is unknown.
    expect(text).toContain("1.935,00");
  });

  it("renders '—' with no percent and no limit flag when the quote is stale", () => {
    const el = TickerChip({ ticker: "OZATD", quote, stale: true });
    const text = textOf(el);
    expect(text).toContain("—");
    expect(text).not.toContain("%");
    expect(text).not.toContain("taban");
  });

  it("the '—' is aria-hidden and followed by a sr-only 'değişim bilinmiyor'", () => {
    const el = TickerChip({ ticker: "OZATD", quote: { ...quote, hasBaseline: false } });
    const all = spans(collect(el));
    const dashIdx = all.findIndex((n) => n.props.children === "—");
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    const dash = all[dashIdx]!;
    expect(dash.props["aria-hidden"]).toBe("true");
    expect(classOf(dash)).toContain("text-muted-foreground");
    const next = all[dashIdx + 1]!;
    expect(next.props.children).toBe("değişim bilinmiyor");
    expect(classOf(next)).toContain("sr-only");
  });

  it("treats a stale cache entry without hasBaseline as a known move", () => {
    const { hasBaseline: _drop, ...legacy } = quote;
    void _drop;
    const text = textOf(TickerChip({ ticker: "OZATD", quote: legacy as Quote }));
    expect(text).toContain("-%10,00");
    expect(text).not.toContain("—");
  });

  it("omitting sinceNews renders no 'haberden' span", () => {
    expect(textOf(TickerChip({ ticker: "OZATD", quote }))).not.toContain("haberden");
    expect(textOf(TickerChip({ ticker: "OZATD", quote, sinceNews: null }))).not.toContain("haberden");
  });

  it("renders just the ticker when there is no quote", () => {
    const text = textOf(TickerChip({ ticker: "OZATD" }));
    expect(text).toBe("OZATD");
  });

  describe("tick-aware limit tag (h11-finance-4)", () => {
    const at = (prevClose: number, price: number): Quote => ({
      ...quote,
      ticker: "INFO",
      prevClose,
      price,
      changePct: ((price - prevClose) / prevClose) * 100,
      closes: [prevClose, price],
    });

    it("INFO 0.66 -> 0.60 (-9.09 %) reads taban: 0.594 steps up to the 0.01 tick", () => {
      const text = textOf(TickerChip({ ticker: "INFO", quote: at(0.66, 0.6) }));
      expect(text).toContain("-%9,09");
      expect(text).toContain("taban");
    });

    it("6.98 -> 6.30 (-9.74 %) shows no tag: 6.29 would still have been a valid price", () => {
      const text = textOf(TickerChip({ ticker: "AAAA", quote: at(6.98, 6.3) }));
      expect(text).toContain("-%9,74");
      expect(text).not.toContain("taban");
      expect(text).not.toContain("tavan");
    });

    it("a quote without a usable prevClose falls back to the 9.5 % rule", () => {
      const text = textOf(TickerChip({ ticker: "AAAA", quote: { ...quote, prevClose: 0, price: 110, changePct: 9.6 } }));
      expect(text).toContain("tavan");
    });
  });

  describe("hit area (WCAG 2.5.8 target size)", () => {
    it("the chip link is at least 24 px tall: py-1.5, not the old py-0.5", () => {
      const root = collect(TickerChip({ ticker: "OZATD", quote }))[0]!;
      const cls = classOf(root);
      expect(cls).toContain("py-1.5");
      expect(cls).not.toContain("py-0.5");
      // 11 px line + 2 x 6 px padding + 2 x 1 px border = 25 px.
      expect(cls).toContain("leading-none");
      expect(cls).toContain("text-[11px]");
      expect(cls).toContain("border");
    });
  });
});

describe("TickerTape", () => {
  const items: TickerAttention[] = [{ ticker: "OZATD", articles: 3, sources: 2, ratio: null, title: "Özata" } as TickerAttention];
  const stats: Record<string, QuoteStat> = {};

  // The strip scrolls inside overflow-x-auto, which clips anything drawn
  // outside a link's box: an outside focus ring is cut off at the top, bottom
  // and ends. An inset ring is drawn inside the link, where it is not clipped.
  it("every strip link draws its focus ring inset so overflow-x-auto cannot clip it", () => {
    const two: TickerAttention[] = [
      { ticker: "OZATD", articles: 3, sources: 2, ratio: null, title: "Özata" } as TickerAttention,
      { ticker: "TURSG", articles: 2, sources: 2, ratio: null, title: "Sigorta" } as TickerAttention,
    ];
    const links = collect(TickerTape({ items: two, quotes: { OZATD: quote }, stats })).filter((n) => n.type === Link);
    expect(links).toHaveLength(2);
    for (const link of links) {
      const cls = classOf(link);
      expect(cls).toContain("focus-visible:ring-inset");
      // Still a visible ring, not an outline.
      expect(cls).toContain("focus-visible:ring-2");
      expect(cls).toContain("focus-visible:ring-ring");
    }
  });

  it("the standalone chip keeps its outside ring (nothing clips it)", () => {
    const root = collect(TickerChip({ ticker: "OZATD", quote }))[0]!;
    expect(classOf(root)).not.toContain("ring-inset");
  });

  // h39-a11y-1 (WCAG 1.4.10 Reflow): .sr-only is position:absolute. The strip
  // clips with overflow-x-auto, but an overflow clip only reaches descendants
  // whose containing block is the scroller or inside it. With no positioned
  // ancestor between the sr-only "değişim bilinmiyor" and <main class=relative>,
  // the span of a chip far to the right (TERA, at x ~ 1766 on a 375 px phone)
  // escaped the clip and made /ekonomi scroll sideways. `relative` on the
  // strip makes the strip the containing block, so the clip applies.
  describe("sr-only move text stays inside the strip's clip (h39-a11y-1)", () => {
    const tokens = (n: Node) => classOf(n).split(/\s+/).filter(Boolean);

    it("the strip div is positioned (relative) as well as overflow-x-auto and tayf-scroll-x", () => {
      const root = collect(TickerTape({ items, quotes: { OZATD: { ...quote, hasBaseline: false } }, stats }))[0]!;
      expect(root.type).toBe("div");
      const cls = tokens(root);
      expect(cls).toContain("relative");
      expect(cls).toContain("overflow-x-auto");
      expect(cls).toContain("tayf-scroll-x");
    });

    it("the 'değişim bilinmiyor' sr-only span is a descendant of that positioned strip", () => {
      const root = collect(TickerTape({ items, quotes: { OZATD: { ...quote, hasBaseline: false } }, stats }))[0]!;
      const unknown = spans(collect(root.props.children)).filter(
        (n) => n.props.children === "değişim bilinmiyor" && tokens(n).includes("sr-only"),
      );
      expect(unknown).toHaveLength(1);
    });

    it("a stale quote puts the same sr-only text under the same positioned strip", () => {
      const root = collect(TickerTape({ items, quotes: { OZATD: quote }, stats, staleTickers: new Set(["OZATD"]) }))[0]!;
      expect(tokens(root)).toContain("relative");
      const unknown = spans(collect(root.props.children)).filter((n) => n.props.children === "değişim bilinmiyor");
      expect(unknown).toHaveLength(1);
    });

    it("every chip with an unknown move adds one sr-only span, all inside the one positioned strip", () => {
      const three: TickerAttention[] = ["OZATD", "TURSG", "TERA"].map(
        (ticker) => ({ ticker, articles: 2, sources: 2, ratio: null, title: ticker }) as TickerAttention,
      );
      const quotes: Record<string, Quote> = {
        OZATD: { ...quote, hasBaseline: false },
        TURSG: { ...quote, ticker: "TURSG", changePct: 4 },
        TERA: { ...quote, ticker: "TERA", hasBaseline: false },
      };
      const nodes = collect(TickerTape({ items: three, quotes, stats }));
      const strips = nodes.filter((n) => n.type === "div" && tokens(n).includes("tayf-scroll-x"));
      expect(strips).toHaveLength(1);
      expect(tokens(strips[0]!)).toContain("relative");
      expect(spans(nodes).filter((n) => n.props.children === "değişim bilinmiyor")).toHaveLength(2);
    });

    it("the chip links are not positioned themselves (they are the unchanged flex items)", () => {
      const links = collect(TickerTape({ items, quotes: { OZATD: { ...quote, hasBaseline: false } }, stats })).filter(
        (n) => n.type === Link,
      );
      expect(links).toHaveLength(1);
      expect(tokens(links[0]!)).not.toContain("relative");
    });
  });

  it("renders the percentage for a known move", () => {
    const el = TickerTape({ items, quotes: { OZATD: quote }, stats });
    const text = textOf(el);
    expect(text).toContain("-%10,00");
    expect(text).toContain("taban");
  });

  it("renders '—' instead of a percentage, and no limit flag, when hasBaseline is false", () => {
    const el = TickerTape({ items, quotes: { OZATD: { ...quote, hasBaseline: false } }, stats });
    const text = textOf(el);
    expect(text).toContain("—");
    expect(text).not.toContain("%");
    expect(text).not.toContain("taban");
    const all = spans(collect(el));
    const dashIdx = all.findIndex((n) => n.props.children === "—");
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(all[dashIdx]!.props["aria-hidden"]).toBe("true");
    expect(all[dashIdx + 1]!.props.children).toBe("değişim bilinmiyor");
    expect(classOf(all[dashIdx + 1]!)).toContain("sr-only");
  });

  describe("the 'ilgi' badge needs a ratio (h11-finance-4)", () => {
    const withRatio = (ratio: number | null): TickerAttention[] => [
      { ticker: "OZATD", articles: 5, sources: 3, ratio, title: "Özata" } as TickerAttention,
    ];

    it("shows no 'ilgi' for a null ratio", () => {
      expect(textOf(TickerTape({ items: withRatio(null), quotes: { OZATD: quote }, stats }))).not.toContain("ilgi");
    });

    it("shows no 'ilgi' below 2x", () => {
      expect(textOf(TickerTape({ items: withRatio(1.9), quotes: { OZATD: quote }, stats }))).not.toContain("ilgi");
    });

    it("shows 'ilgi 3,0x' at 3x", () => {
      expect(textOf(TickerTape({ items: withRatio(3), quotes: { OZATD: quote }, stats }))).toContain("ilgi 3,0x");
    });
  });

  describe("tick-aware limit tag (h11-finance-4)", () => {
    const info: TickerAttention[] = [{ ticker: "INFO", articles: 4, sources: 2, ratio: null, title: "İnfo" } as TickerAttention];
    const quoteAt = (prevClose: number, price: number): Quote => ({
      ...quote,
      ticker: "INFO",
      prevClose,
      price,
      changePct: ((price - prevClose) / prevClose) * 100,
    });

    it("INFO 0.66 -> 0.60 is taban on the tape", () => {
      expect(textOf(TickerTape({ items: info, quotes: { INFO: quoteAt(0.66, 0.6) }, stats }))).toContain("taban");
    });

    it("6.98 -> 6.30 is not", () => {
      const text = textOf(TickerTape({ items: info, quotes: { INFO: quoteAt(6.98, 6.3) }, stats }));
      expect(text).not.toContain("taban");
      expect(text).not.toContain("tavan");
    });
  });

  describe("rebased quotes (h36-data-1)", () => {
    const thy: TickerAttention[] = [{ ticker: "THYAO", articles: 6, sources: 4, ratio: null, title: "THY" } as TickerAttention];
    // What Yahoo served at 08:10Z on 2026-11-05: the live price measured against
    // the 11-03 close (265.00) instead of the 11-04 close (291.25).
    const yahoo: Quote = {
      ticker: "THYAO",
      price: 301,
      prevClose: 265,
      changePct: 13.58,
      hasBaseline: true,
      closes: [262, 265, 291.25, 301],
      currency: "TRY",
      asOf: "2026-11-05T08:10:00Z",
    };
    const thyStat: QuoteStat = {
      ticker: "THYAO",
      lastDay: "2026-11-04",
      lastClose: 291.25,
      prevClose: 265,
      lastVolume: 1000,
      avgVolume20: 900,
      rvol: 1.1,
    };

    it("the raw Yahoo quote is the bug: +%13,58 and a tavan tag", () => {
      const text = textOf(TickerTape({ items: thy, quotes: { THYAO: yahoo }, stats: { THYAO: thyStat } }));
      expect(text).toContain("+%13,58");
      expect(text).toContain("tavan");
    });

    it("THYAO rebased on the 11-04 close renders +%3,35 and no tavan", () => {
      const rebased = rebaseQuoteOnStat(yahoo, thyStat);
      const text = textOf(TickerTape({ items: thy, quotes: { THYAO: rebased }, stats: { THYAO: thyStat } }));
      expect(text).toContain("+%3,35");
      expect(text).not.toContain("13,58");
      expect(text).not.toContain("tavan");
      expect(text).not.toContain("taban");
    });

    it("the chip reads the same rebased quote", () => {
      const text = textOf(TickerChip({ ticker: "THYAO", quote: rebaseQuoteOnStat(yahoo, thyStat) }));
      expect(text).toContain("+%3,35");
      expect(text).not.toContain("tavan");
    });

    it("a quote the band guard rejects renders '—' with no percent and no limit tag, price kept", () => {
      const guarded = rebaseQuoteOnStat({ ...yahoo, price: 11.8, prevClose: 109.1, changePct: -89.18 }, undefined);
      const tape = textOf(TickerTape({ items: thy, quotes: { THYAO: guarded }, stats: {} }));
      const chip = textOf(TickerChip({ ticker: "THYAO", quote: guarded }));
      for (const text of [tape, chip]) {
        expect(text).toContain("—");
        expect(text).not.toContain("%");
        expect(text).not.toContain("tavan");
        expect(text).not.toContain("taban");
        expect(text).toContain("11,80");
      }
    });
  });

  describe("stale quotes (TERA: last bar days old)", () => {
    const staleTickers = new Set(["OZATD"]);
    const rvolStats: Record<string, QuoteStat> = {
      OZATD: { ticker: "OZATD", lastDay: "2026-10-27", lastClose: 1935, prevClose: 2150, lastVolume: 9000, avgVolume20: 3000, rvol: 3 },
    };

    it("renders '—' (aria-hidden, with sr-only text), no percentage, no limit tag and no rvol for a stale quote", () => {
      const el = TickerTape({ items, quotes: { OZATD: quote }, stats: rvolStats, staleTickers });
      const text = textOf(el);
      expect(text).toContain("—");
      expect(text).not.toContain("%");
      expect(text).not.toContain("taban");
      expect(text).not.toContain("tavan");
      expect(text).not.toContain("hacim");
      const all = spans(collect(el));
      const dashIdx = all.findIndex((n) => n.props.children === "—");
      expect(dashIdx).toBeGreaterThanOrEqual(0);
      expect(all[dashIdx]!.props["aria-hidden"]).toBe("true");
      expect(all[dashIdx + 1]!.props.children).toBe("değişim bilinmiyor");
      expect(classOf(all[dashIdx + 1]!)).toContain("sr-only");
    });

    it("still shows the price of a stale quote (only the move is unknown), as the chip does", () => {
      const el = TickerTape({ items, quotes: { OZATD: quote }, stats: rvolStats, staleTickers });
      expect(textOf(el)).toContain("1.935");
    });

    it("another ticker that is not stale keeps its move, limit tag and rvol", () => {
      const other: TickerAttention[] = [
        { ticker: "OZATD", articles: 3, sources: 2, ratio: null, title: "Özata" } as TickerAttention,
        { ticker: "TURSG", articles: 2, sources: 2, ratio: null, title: "Sigorta" } as TickerAttention,
      ];
      const el = TickerTape({
        items: other,
        quotes: { OZATD: quote, TURSG: { ...quote, ticker: "TURSG", price: 100, changePct: 10, prevClose: 90.9 } },
        stats: { ...rvolStats, TURSG: { ...rvolStats.OZATD!, ticker: "TURSG", lastDay: "2026-10-30", rvol: 2.5 } },
        staleTickers,
      });
      const text = textOf(el);
      expect(text).toContain("+%10,00");
      expect(text).toContain("tavan");
      expect(text).toContain("hacim");
      expect(text).not.toContain("-%10,00");
    });

    it("without staleTickers nothing is stale (existing behaviour)", () => {
      const text = textOf(TickerTape({ items, quotes: { OZATD: quote }, stats: rvolStats }));
      expect(text).toContain("-%10,00");
      expect(text).toContain("hacim");
    });
  });
});

// h57-ekonomi-1: readQuoteStats now hands the tape the unrounded ratio, so the
// single 1-dp display rounding and the ">= 2" amber threshold act on the true
// value. These pin that contract at the render boundary.
describe("TickerTape relative volume on an unrounded ratio (h57-ekonomi-1)", () => {
  const item: TickerAttention[] = [
    { ticker: "GARAN", articles: 3, sources: 2, ratio: null, title: "Garanti" } as TickerAttention,
  ];
  const garanQuote: Quote = { ...quote, ticker: "GARAN", price: 150, prevClose: 149, changePct: 0.67 };
  const withRvol = (rvol: number): Record<string, QuoteStat> => ({
    GARAN: { ticker: "GARAN", lastDay: "2026-11-06", lastClose: 150, prevClose: 149, lastVolume: 1, avgVolume20: 1, rvol },
  });
  const hacimSpan = (rvol: number) => {
    const el = TickerTape({ items: item, quotes: { GARAN: garanQuote }, stats: withRvol(rvol) });
    return spans(collect(el)).find((n) => textOf(n.props.children).startsWith("hacim"));
  };

  it("1.84875 renders 'hacim 1,8x' and is not amber", () => {
    const n = hacimSpan(1.84875);
    expect(n).toBeDefined();
    expect(textOf(n!.props.children)).toBe("hacim 1,8x");
    expect(classOf(n!)).not.toContain("text-amber-400");
  });

  it("2.0003 is amber", () => {
    const n = hacimSpan(2.0003);
    expect(n).toBeDefined();
    expect(classOf(n!)).toContain("text-amber-400");
  });

  it("1.996 is not amber (a stored 2.00 would have been)", () => {
    const n = hacimSpan(1.996);
    expect(n).toBeDefined();
    expect(classOf(n!)).not.toContain("text-amber-400");
  });
});
