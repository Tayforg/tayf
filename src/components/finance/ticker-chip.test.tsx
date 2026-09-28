import { describe, expect, it } from "vitest";
import { TickerChip } from "./ticker-chip";
import type { Quote } from "@/lib/finance/quotes";

// Walks the element tree the way label-card.test.tsx and framing-game.test.tsx
// do, since vitest runs in a plain node environment (no jsdom/RTL).
function collect(node: unknown, out: { type: unknown; props: Record<string, unknown> }[] = []) {
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

const quote: Quote = {
  ticker: "OZATD",
  price: 1935,
  prevClose: 2150,
  changePct: -10,
  closes: [2150, 1935],
  currency: "TRY",
  asOf: new Date().toISOString(),
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
});
