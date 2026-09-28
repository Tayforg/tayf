import { describe, it, expect } from "vitest";
import { ClickbaitKarneSection, ClickbaitKarneLine } from "./clickbait-karne";
import type { ClickbaitKarne, ClickbaitPrecisionCheck } from "@/lib/sources/clickbait";

// Walks the element tree the way label-card.test.tsx does — both
// components here are synchronous Server Components with plain-data props.

interface MinimalNode {
  props?: { children?: unknown; href?: string };
}

function isNode(value: unknown): value is MinimalNode {
  return typeof value === "object" && value !== null && "props" in value;
}

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const maybe = node as MinimalNode;
  if (maybe && typeof maybe === "object" && "props" in maybe) {
    return collectText(maybe.props?.children);
  }
  return [];
}

function findAll(node: unknown, predicate: (n: MinimalNode) => boolean): MinimalNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!isNode(node)) return [];
  const self = predicate(node) ? [node] : [];
  return self.concat(findAll(node.props?.children, predicate));
}

function karne(overrides: Partial<ClickbaitKarne> = {}): ClickbaitKarne {
  const outlets = Array.from({ length: 9 }, (_, i) => ({
    slug: `outlet-${i}`,
    name: `Outlet ${i}`,
    bias: "center" as const,
    zone: "bagimsiz" as const,
    n: 300 + i,
    nFlagged: (i + 1) * 10,
    share: ((i + 1) * 10) / (300 + i),
    meanProb: 0.3 + i / 100,
    tier: i < 3 ? ("low" as const) : i < 6 ? ("mid" as const) : ("high" as const),
  }));
  return {
    outlets,
    firstDay: "2026-09-24",
    lastDay: "2026-09-28",
    outletCount: outlets.length,
    questionSets: ["2026-09-24.1"],
    minN: 300,
    ...overrides,
  };
}

const CHECK: ClickbaitPrecisionCheck = {
  checkedOn: "2026-09-28",
  sample: 200,
  clickbait: 170,
  precision: 0.85,
  threshold: 0.7,
  questionSets: ["2026-09-24.1"],
  labeler: "model-proxy (single labeller)",
};

describe("ClickbaitKarneSection", () => {
  it("returns null (renders nothing) when karne is null", () => {
    expect(ClickbaitKarneSection({ karne: null, check: null })).toBeNull();
  });

  it("shows three tier headings, /source links, the question text, n and the window", () => {
    const el = ClickbaitKarneSection({ karne: karne(), check: null });
    const text = collectText(el).join(" ");
    expect(text).toContain("Düşük");
    expect(text).toContain("Orta");
    expect(text).toContain("Yüksek");
    expect(text).toContain("300 başlık");
    expect(text).toContain("24.09.2026");
    expect(text).toContain("28.09.2026");
    expect(text).toMatch(/Bu başlık, tıklatmak için asıl bilgiyi/);

    const links = findAll(el, (n) => typeof n.props?.href === "string" && n.props.href.startsWith("/source/"));
    expect(links.length).toBe(9);
  });

  it("contains NO '%' character (terciles, not percentages)", () => {
    const el = ClickbaitKarneSection({ karne: karne(), check: CHECK });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("%");
  });

  it("does not show the share/mean by default (showShares = false)", () => {
    const el = ClickbaitKarneSection({ karne: karne(), check: null });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("pay ");
  });

  it("shows the share/mean when showShares is true (admin)", () => {
    const el = ClickbaitKarneSection({ karne: karne(), check: null, showShares: true });
    const text = collectText(el).join(" ");
    expect(text).toContain("pay ");
  });

  it("the precision sentence appears only when check is non-null", () => {
    const withoutCheck = collectText(ClickbaitKarneSection({ karne: karne(), check: null })).join(" ");
    expect(withoutCheck).not.toMatch(/tanesi gerçekten tık tuzağıydı/);

    const withCheck = collectText(ClickbaitKarneSection({ karne: karne(), check: CHECK })).join(" ");
    expect(withCheck).toMatch(/170 tanesi gerçekten tık tuzağıydı/);
  });

  it("includes a dispute link to /metodoloji#duzeltme", () => {
    const el = ClickbaitKarneSection({ karne: karne(), check: null });
    const links = findAll(el, (n) => n.props?.href === "/metodoloji#duzeltme");
    expect(links.length).toBeGreaterThan(0);
  });
});

describe("ClickbaitKarneLine", () => {
  it("returns null when karne is null", () => {
    expect(ClickbaitKarneLine({ karne: null, slug: "outlet-0", check: null })).toBeNull();
  });

  it("shows the tier, n, window and outlet count for an eligible outlet", () => {
    const el = ClickbaitKarneLine({ karne: karne(), slug: "outlet-0", check: null });
    const text = collectText(el).join(" ");
    expect(text).toContain("Tık tuzağı işareti: Düşük");
    expect(text).toContain("300 başlık");
    expect(text).toContain("9 kaynak arasında sıralama");
  });

  it("shows the not-enough-data message for an outlet not in the karne", () => {
    const el = ClickbaitKarneLine({ karne: karne(), slug: "unknown-outlet", check: null });
    const text = collectText(el).join(" ");
    expect(text).toContain("Bu kaynak için henüz yeterli başlık yok");
    expect(text).not.toContain("Tık tuzağı işareti:");
  });

  it("contains NO '%' character", () => {
    const el = ClickbaitKarneLine({ karne: karne(), slug: "outlet-0", check: CHECK });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("%");
  });
});
