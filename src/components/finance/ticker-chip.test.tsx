import { describe, expect, it } from "vitest";
import { TickerChip, TickerTape } from "./ticker-chip";
import type { Quote } from "@/lib/finance/quotes";
import type { QuoteStat, TickerAttention } from "@/lib/finance/queries";

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
    expect(text).toContain("-10,00%");
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
    expect(text).toContain("-10,00%");
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
      expect(text).toContain("-9,09%");
      expect(text).toContain("taban");
    });

    it("6.98 -> 6.30 (-9.74 %) shows no tag: 6.29 would still have been a valid price", () => {
      const text = textOf(TickerChip({ ticker: "AAAA", quote: at(6.98, 6.3) }));
      expect(text).toContain("-9,74%");
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

  it("renders the percentage for a known move", () => {
    const el = TickerTape({ items, quotes: { OZATD: quote }, stats });
    const text = textOf(el);
    expect(text).toContain("-10,00%");
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
      expect(text).toContain("+10,00%");
      expect(text).toContain("tavan");
      expect(text).toContain("hacim");
      expect(text).not.toContain("-10,00%");
    });

    it("without staleTickers nothing is stale (existing behaviour)", () => {
      const text = textOf(TickerTape({ items, quotes: { OZATD: quote }, stats: rvolStats }));
      expect(text).toContain("-10,00%");
      expect(text).toContain("hacim");
    });
  });
});
