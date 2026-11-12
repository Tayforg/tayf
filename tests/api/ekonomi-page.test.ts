import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h41-resilience-3 -- /ekonomi must not fall to the error page when a
// DECORATIVE read fails.
//
// Essential reads (the econ feed, the top tickers, the KAP disclosures) still
// throw to src/app/ekonomi/error.tsx: without them there is nothing to show.
// Decorative reads degrade to their section's empty state:
//   - fetchCircuitBreakers  -> BreakerStrip gets { breakers: [], unavailable: true }
//   - fetchQuoteStats       -> every quote loses its baseline (a move is shown as
//                              "—", never re-based and never tagged tavan/taban
//                              from Yahoo's two-sessions-back close, h36-data-1)
//   - fetchReferencePrices  -> the "since the headline" values are null ("—")
// getQuotes is not touched: it already resolves {} on failure.
//
// The page is a server component, so these tests read the returned element
// tree instead of rendering it.
//
// h159-perf-2: the header renders in the static PPR shell. EkonomiPage is a plain
// function; the data (connection(), every read, the quotes re-basing, the market
// cue text) lives in loadEkonomiView, which the Suspense-wrapped EkonomiBody awaits.
// The resilience cases below therefore drive loadEkonomiView() and the element tree
// of EkonomiBody, with the same assertions as before. Outside the server renderer
// React's cache() is a pass-through, so every call here runs the view once, as one
// request would.
//
// h161-cls-1: the market cue is the first element of EkonomiBody, not a second
// Suspense island in the header, so it lands in the same swap as the body and shifts
// nothing (it used to push the visible skeleton down 18 px after first paint).
// ---------------------------------------------------------------------------

const {
  connectionMock,
  fetchEconFeedMock,
  fetchTopTickersMock,
  fetchRecentDisclosuresMock,
  fetchCircuitBreakersMock,
  fetchQuoteStatsMock,
  fetchReferencePricesMock,
  getQuotesMock,
} = vi.hoisted(() => ({
  connectionMock: vi.fn(async () => undefined),
  fetchEconFeedMock: vi.fn(),
  fetchTopTickersMock: vi.fn(),
  fetchRecentDisclosuresMock: vi.fn(),
  fetchCircuitBreakersMock: vi.fn(),
  fetchQuoteStatsMock: vi.fn(),
  fetchReferencePricesMock: vi.fn(),
  getQuotesMock: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: connectionMock };
});

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

vi.mock("@/lib/finance/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance/queries")>();
  return {
    ...actual,
    fetchEconFeed: (...args: unknown[]) => fetchEconFeedMock(...args),
    fetchTopTickers: (...args: unknown[]) => fetchTopTickersMock(...args),
    fetchRecentDisclosures: (...args: unknown[]) => fetchRecentDisclosuresMock(...args),
    fetchCircuitBreakers: (...args: unknown[]) => fetchCircuitBreakersMock(...args),
    fetchQuoteStats: (...args: unknown[]) => fetchQuoteStatsMock(...args),
    fetchReferencePrices: (...args: unknown[]) => fetchReferencePricesMock(...args),
  };
});

vi.mock("@/lib/finance/quotes", () => ({
  getQuotes: (...args: unknown[]) => getQuotesMock(...args),
}));

import EkonomiPage, { EkonomiBody, loadEkonomiView } from "@/app/ekonomi/page";
import { EkonomiBodySkeleton } from "@/app/ekonomi/loading";
import { BreakerStrip } from "@/components/finance/breaker-strip";
import { Panel } from "@/components/finance/panel";
import { TickerChip, TickerTape } from "@/components/finance/ticker-chip";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { refKey } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";

type El = { type: unknown; props: Record<string, unknown> };

function collectEls(node: unknown, out: El[] = []): El[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectEls(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props !== undefined) {
    out.push({ type: el.type, props: el.props });
    collectEls(el.props.children, out);
  }
  return out;
}

// 2026-11-05 is a Thursday; 11:50Z is 14:50 in Istanbul, inside the session.
const NOW = new Date("2026-11-05T12:00:00Z");
const AS_OF = "2026-11-05T11:50:00.000Z";

// Yahoo's own payload during the session: the previous close is the one from two
// sessions back (300), so +10 % reads as tavan. The settled close is 320, so the
// real move is +3,125 %.
const yahooQuote = (): Quote => ({
  ticker: "THYAO",
  price: 330,
  prevClose: 300,
  changePct: 10,
  hasBaseline: true,
  closes: [290, 300, 330],
  currency: "TRY",
  asOf: AS_OF,
});

const STATS = {
  THYAO: { ticker: "THYAO", lastDay: "2026-11-04", lastClose: 320, prevClose: 310, lastVolume: 100, avgVolume20: 80, rvol: 1.25 },
};

const FEED = [
  {
    id: "a1",
    title: "THY yeni uçak siparişi verdi",
    url: "https://example.com/a1",
    publishedAt: "2026-11-05T08:00:00.000Z",
    category: "ekonomi",
    source: { name: "Dünya", slug: "dunya" },
    tickers: ["THYAO"],
  },
];

const TOP = [{ ticker: "THYAO", title: "TÜRK HAVA YOLLARI", articles: 5, sources: 3, ratio: null }];

const BREAKERS = [
  {
    disclosureIndex: 1,
    publishedAt: "2026-11-05T09:00:00.000Z",
    kapTitle: "X A.Ş.",
    stockCodes: ["XYZ"],
    subject: "Devre Kesici",
    summary: null,
    disclosureClass: null,
  },
];

function stubHealthyReads() {
  fetchEconFeedMock.mockResolvedValue(FEED);
  fetchTopTickersMock.mockResolvedValue(TOP);
  fetchRecentDisclosuresMock.mockResolvedValue([]);
  fetchCircuitBreakersMock.mockResolvedValue(BREAKERS);
  fetchQuoteStatsMock.mockResolvedValue(STATS);
  // The price at the headline: 310 -> 330 is +6,45 %.
  fetchReferencePricesMock.mockResolvedValue({ [refKey("a1", "THYAO")]: 310 });
  getQuotesMock.mockResolvedValue({ THYAO: yahooQuote() });
}

async function render() {
  return collectEls(await EkonomiBody());
}

const tapeQuotes = (els: El[]) => els.find((e) => e.type === TickerTape)!.props.quotes as Record<string, Quote>;
const feedChips = (els: El[]) => els.filter((e) => e.type === TickerChip && "sinceNews" in e.props);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const m of [
    connectionMock,
    fetchEconFeedMock,
    fetchTopTickersMock,
    fetchRecentDisclosuresMock,
    fetchCircuitBreakersMock,
    fetchQuoteStatsMock,
    fetchReferencePricesMock,
    getQuotesMock,
  ]) {
    m.mockReset();
  }
  connectionMock.mockResolvedValue(undefined);
  stubHealthyReads();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("/ekonomi -- nothing fails (unchanged)", () => {
  it("hands the strip the notices, re-bases the move on the settled close and keeps the since-headline value", async () => {
    const els = await render();

    const strip = els.find((e) => e.type === BreakerStrip)!;
    expect(strip.props.breakers).toEqual(BREAKERS);
    expect(strip.props.unavailable).toBeFalsy();

    const q = tapeQuotes(els).THYAO!;
    expect(q.hasBaseline).toBe(true);
    expect(q.prevClose).toBe(320);
    expect(q.changePct).toBeCloseTo(3.125, 3);

    const [chip] = feedChips(els);
    expect(chip!.props.sinceNews).toBeCloseTo(6.4516, 3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("looks the quotes, stats and references up once each, for the same ticker set", async () => {
    await render();

    expect(getQuotesMock).toHaveBeenCalledTimes(1);
    expect(fetchQuoteStatsMock).toHaveBeenCalledWith(["THYAO"]);
    expect(fetchReferencePricesMock).toHaveBeenCalledWith(["a1"]);
    expect(connectionMock).toHaveBeenCalledTimes(1);
  });
});

describe("/ekonomi -- fetchCircuitBreakers rejects", () => {
  it("resolves, and the strip gets no notices and says it is unavailable", async () => {
    fetchCircuitBreakersMock.mockRejectedValue(new Error("[finance] fetchCircuitBreakers: statement timeout"));

    const els = await render();

    const strip = els.find((e) => e.type === BreakerStrip)!;
    expect(strip.props).toEqual({ breakers: [], unavailable: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: circuit-breakers");
  });

  it("leaves the rest of the page as it was: same quotes, same since-headline value", async () => {
    fetchCircuitBreakersMock.mockRejectedValue(new Error("boom"));

    const els = await render();

    expect(tapeQuotes(els).THYAO!.prevClose).toBe(320);
    expect(feedChips(els)[0]!.props.sinceNews).toBeCloseTo(6.4516, 3);
  });
});

describe("/ekonomi -- fetchQuoteStats rejects", () => {
  it("resolves, and no quote handed to the tape has a known move (no day move, no tavan/taban)", async () => {
    fetchQuoteStatsMock.mockRejectedValue(new Error("[finance] fetchQuoteStats: statement timeout"));

    const els = await render();

    const quotes = tapeQuotes(els);
    expect(Object.keys(quotes)).toEqual(["THYAO"]);
    for (const q of Object.values(quotes)) expect(q.hasBaseline).toBe(false);
    // The price itself is still Yahoo's.
    expect(quotes.THYAO!.price).toBe(330);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: quote-stats");
  });

  it("never falls back to Yahoo's two-sessions-back close: the same quote WITH stats gets a re-based move", async () => {
    const withStats = tapeQuotes(await render()).THYAO!;
    expect(withStats.hasBaseline).toBe(true);

    fetchQuoteStatsMock.mockRejectedValue(new Error("boom"));
    const withoutStats = tapeQuotes(await render()).THYAO!;
    expect(withoutStats.hasBaseline).toBe(false);
  });

  it("hands every chip the baseline-less quote and the tape an empty stats map (no relative volume)", async () => {
    fetchQuoteStatsMock.mockRejectedValue(new Error("boom"));

    const els = await render();

    const tape = els.find((e) => e.type === TickerTape)!;
    expect(tape.props.stats).toEqual({});
    const chips = els.filter((e) => e.type === TickerChip);
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect((c.props.quote as Quote).hasBaseline).toBe(false);
  });

  it("leaves the circuit-breaker strip and the since-headline value alone", async () => {
    fetchQuoteStatsMock.mockRejectedValue(new Error("boom"));

    const els = await render();

    expect(els.find((e) => e.type === BreakerStrip)!.props.breakers).toEqual(BREAKERS);
    expect(feedChips(els)[0]!.props.sinceNews).toBeCloseTo(6.4516, 3);
  });
});

describe("/ekonomi -- fetchReferencePrices rejects", () => {
  it("resolves, and every since-headline value is null", async () => {
    fetchReferencePricesMock.mockRejectedValue(new Error("[finance] fetchReferencePrices: statement timeout"));

    const els = await render();

    const chips = feedChips(els);
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.props.sinceNews).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: reference-prices");
  });

  it("still re-bases the day move on the stats", async () => {
    fetchReferencePricesMock.mockRejectedValue(new Error("boom"));

    expect(tapeQuotes(await render()).THYAO!.hasBaseline).toBe(true);
  });
});

describe("/ekonomi -- every optional read rejects at once", () => {
  it("still resolves, with one warning per read and nothing else logged", async () => {
    fetchCircuitBreakersMock.mockRejectedValue(new Error("a"));
    fetchQuoteStatsMock.mockRejectedValue(new Error("b"));
    fetchReferencePricesMock.mockRejectedValue(new Error("c"));

    const els = await render();

    expect(els.find((e) => e.type === BreakerStrip)!.props).toEqual({ breakers: [], unavailable: true });
    expect(tapeQuotes(els).THYAO!.hasBaseline).toBe(false);
    expect(feedChips(els)[0]!.props.sinceNews).toBeNull();
    expect(warn.mock.calls.map((c) => c[0]).sort()).toEqual([
      "[ekonomi] optional read failed: circuit-breakers",
      "[ekonomi] optional read failed: quote-stats",
      "[ekonomi] optional read failed: reference-prices",
    ]);
  });

  it("does not touch getQuotes: it already degrades to {} on its own", async () => {
    getQuotesMock.mockResolvedValue({});
    fetchQuoteStatsMock.mockRejectedValue(new Error("b"));

    const els = await render();

    expect(tapeQuotes(els)).toEqual({});
    expect(getQuotesMock).toHaveBeenCalledTimes(1);
  });
});

describe("/ekonomi -- an essential read still throws to the error boundary", () => {
  it("fetchEconFeed rejecting rejects the view with that error", async () => {
    const boom = new Error("[finance] fetchEconFeed: statement timeout");
    fetchEconFeedMock.mockRejectedValue(boom);

    await expect(loadEkonomiView()).rejects.toBe(boom);
    expect(warn).not.toHaveBeenCalled();
    // Without the feed there is no ticker set to quote.
    expect(getQuotesMock).not.toHaveBeenCalled();
  });

  it("fetchTopTickers rejecting rejects the view", async () => {
    fetchTopTickersMock.mockRejectedValue(new Error("[finance] fetchTopTickers: statement timeout"));

    await expect(loadEkonomiView()).rejects.toThrow("fetchTopTickers");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fetchRecentDisclosures rejecting rejects the view", async () => {
    fetchRecentDisclosuresMock.mockRejectedValue(new Error("[finance] fetchRecentDisclosures: statement timeout"));

    await expect(loadEkonomiView()).rejects.toThrow("fetchRecentDisclosures");
    expect(warn).not.toHaveBeenCalled();
  });

  it("an essential failure together with a decorative one still rejects, with no unhandled rejection", async () => {
    const boom = new Error("[finance] fetchEconFeed: statement timeout");
    fetchEconFeedMock.mockRejectedValue(boom);
    fetchCircuitBreakersMock.mockRejectedValue(new Error("breakers down too"));

    await expect(loadEkonomiView()).rejects.toBe(boom);
  });

  it("the Suspense child (the body, cue included) rejects with that error, so the error boundary (error.tsx) renders; nothing is caught", async () => {
    const boom = new Error("[finance] fetchEconFeed: statement timeout");
    fetchEconFeedMock.mockRejectedValue(boom);

    await expect(EkonomiBody()).rejects.toBe(boom);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// h159-perf-2: the view model and the market cue.
// ---------------------------------------------------------------------------
describe("/ekonomi -- loadEkonomiView (h159-perf-2)", () => {
  it("calls connection() before any read, and reads the clock after it", async () => {
    await loadEkonomiView();

    expect(connectionMock).toHaveBeenCalledTimes(1);
    const connectionAt = connectionMock.mock.invocationCallOrder[0]!;
    for (const m of [fetchEconFeedMock, fetchTopTickersMock, fetchRecentDisclosuresMock, fetchCircuitBreakersMock]) {
      expect(m.mock.invocationCallOrder[0]!).toBeGreaterThan(connectionAt);
    }
  });

  it("returns the re-based quotes, the optional reads' outcome and the stale set the body draws", async () => {
    const view = await loadEkonomiView();

    expect(view.feed).toEqual(FEED);
    expect(view.top).toEqual(TOP);
    expect(view.breakers).toEqual(BREAKERS);
    expect(view.breakersFailed).toBe(false);
    expect(view.quotes.THYAO!.prevClose).toBe(320);
    expect(view.quotes.THYAO!.changePct).toBeCloseTo(3.125, 3);
    expect(view.staleTickers.size).toBe(0);
    // A live quote during the session needs no cue.
    expect(view.marketCue).toBeNull();
  });

  it("marks a quote whose last trade is days old as stale", async () => {
    getQuotesMock.mockResolvedValue({ THYAO: { ...yahooQuote(), asOf: "2026-10-30T15:00:00.000Z" } });

    const view = await loadEkonomiView();

    expect([...view.staleTickers]).toEqual(["THYAO"]);
  });
});

// ---------------------------------------------------------------------------
// h161-cls-1: the market cue is the FIRST element of EkonomiBody. It used to be a
// second Suspense island inside the header; it streamed in after the header painted,
// grew the header by one line and moved the visible body skeleton down 18 px. Inside
// the body it lands in the same swap that replaces the skeleton. While the market is
// live there is no cue and nothing is rendered in its place (no blank reserved line).
// ---------------------------------------------------------------------------
describe("/ekonomi -- the market cue is the first element of the body (h161-cls-1)", () => {
  // 2026-11-05 is a Thursday; 16:00Z is 19:00 in Istanbul, after the 18:15 close.
  const AFTER_CLOSE = new Date("2026-11-05T16:00:00Z");
  const CLOSED_CUE = "Piyasa kapalı · son seans 05.11";
  const DELAYED_CUE = "Veriler gecikmeli · son seans 04.11";

  function textOfNode(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOfNode).join("");
    return textOfNode((node as { props?: { children?: unknown } }).props?.children);
  }
  /** The body's rendered top-level children, in order (a conditional that is null/false renders nothing and is dropped). */
  const topLevel = (tree: unknown): unknown[] =>
    ([] as unknown[]).concat((tree as { props: { children: unknown } }).props.children).filter((c) => c != null && typeof c !== "boolean");
  /** Every element whose whole text is exactly `text`, in document order. */
  const printing = (els: El[], text: string) => els.filter((e) => e.type === "p" && textOfNode(e.props.children) === text);
  const firstPanelAt = (els: El[]) => els.findIndex((e) => e.type === Panel);

  it("after the close it renders the cue text exactly once, before the tape, the strip and the first panel, in font-mono text-[12px]", async () => {
    vi.setSystemTime(AFTER_CLOSE);

    const tree = await EkonomiBody();
    const els = collectEls(tree);

    const cues = printing(els, CLOSED_CUE);
    expect(cues).toHaveLength(1);
    const cueAt = els.indexOf(cues[0]!);
    expect(cueAt).toBeGreaterThan(-1);
    const tapeAt = els.findIndex((e) => e.type === TickerTape);
    const stripAt = els.findIndex((e) => e.type === BreakerStrip);
    expect(tapeAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(-1);
    expect(firstPanelAt(els)).toBeGreaterThan(-1);
    expect(cueAt).toBeLessThan(tapeAt);
    expect(cueAt).toBeLessThan(stripAt);
    expect(cueAt).toBeLessThan(firstPanelAt(els));
    // The same text is not printed anywhere else in the body.
    expect(textOfNode(tree).split(CLOSED_CUE)).toHaveLength(2);

    // First child of the body, wrapped to keep the look it had in the header row.
    const [first] = topLevel(tree) as El[];
    expect(first!.type).toBe("div");
    expect(first!.props.className).toBe("font-mono text-[12px]");
    const inner = first!.props.children as El;
    expect(inner.type).toBe("p");
    expect(inner.props.className).toBe("text-muted-foreground");
    expect(inner.props.children).toBe(CLOSED_CUE);
  });

  it("during the session with a not-today quote it prints the delayed-data wording, once, first", async () => {
    getQuotesMock.mockResolvedValue({ THYAO: { ...yahooQuote(), asOf: "2026-11-04T15:00:00.000Z" } });

    const tree = await EkonomiBody();

    expect(printing(collectEls(tree), DELAYED_CUE)).toHaveLength(1);
    const [first] = topLevel(tree) as El[];
    expect(first!.props.className).toBe("font-mono text-[12px]");
    expect(textOfNode(first)).toBe(DELAYED_CUE);
  });

  it("with a live market no cue renders and the tape is the first element", async () => {
    const tree = await EkonomiBody();
    const els = collectEls(tree);

    expect((await loadEkonomiView()).marketCue).toBeNull();
    expect((topLevel(tree)[0] as El).type).toBe(TickerTape);
    for (const wording of ["Piyasa kapalı", "Veriler gecikmeli"]) {
      expect(textOfNode(tree).includes(wording), wording).toBe(false);
    }
    expect(els.some((e) => e.type === "div" && String(e.props.className) === "font-mono text-[12px]")).toBe(false);
  });

  it("with no quotes at all no cue renders either", async () => {
    getQuotesMock.mockResolvedValue({});
    vi.setSystemTime(AFTER_CLOSE);

    const tree = await EkonomiBody();

    expect((topLevel(tree)[0] as El).type).toBe(TickerTape);
    expect(textOfNode(tree).includes("Piyasa kapalı")).toBe(false);
  });

  it("the cue is the only difference between the closed and the live body: the same children follow it", async () => {
    const live = topLevel(await EkonomiBody());
    vi.setSystemTime(AFTER_CLOSE);
    const closed = topLevel(await EkonomiBody());

    // The tape, the strip, the panel grid and the data note.
    expect(live).toHaveLength(4);
    expect(closed).toHaveLength(live.length + 1);
    expect(textOfNode(closed[0])).toBe(CLOSED_CUE);
    expect(closed.slice(1)).toEqual(live);
  });

  it("reads the view once for the cue and the body together (no second read)", async () => {
    getQuotesMock.mockResolvedValue({ THYAO: { ...yahooQuote(), asOf: "2026-11-04T15:00:00.000Z" } });

    await EkonomiBody();

    expect(connectionMock).toHaveBeenCalledTimes(1);
    expect(getQuotesMock).toHaveBeenCalledTimes(1);
    expect(fetchEconFeedMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// h159-perf-2: the static shell. EkonomiPage() is a plain element tree: the h1 and the
// subtitle (the LCP text) are reachable without passing a Suspense boundary, so they
// paint with the PPR shell; the cue and the body each sit inside one.
// ---------------------------------------------------------------------------
describe("/ekonomi -- the header renders in the static shell (h159-perf-2)", () => {
  type Hit = { el: El; inSuspense: boolean };

  /** Every element of the tree with whether a Suspense element sits between it and the root. */
  function walkTree(node: unknown, inSuspense = false, out: Hit[] = []): Hit[] {
    if (node == null || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const n of node) walkTree(n, inSuspense, out);
      return out;
    }
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (el.props === undefined) return out;
    out.push({ el: { type: el.type, props: el.props }, inSuspense });
    walkTree(el.props.children, inSuspense || el.type === Suspense, out);
    return out;
  }

  function textOfNode(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOfNode).join("");
    return textOfNode((node as { props?: { children?: unknown } }).props?.children);
  }

  it("returns a plain element, not a thenable", () => {
    const tree = EkonomiPage();

    expect(tree).not.toBeInstanceOf(Promise);
    expect(typeof (tree as unknown as { then?: unknown }).then).toBe("undefined");
    expect(tree.type).toBe("div");
  });

  it("reads no data and no clock while building the shell", () => {
    const nowSpy = vi.spyOn(Date, "now");

    EkonomiPage();

    expect(connectionMock).not.toHaveBeenCalled();
    for (const m of [fetchEconFeedMock, fetchTopTickersMock, fetchRecentDisclosuresMock, fetchCircuitBreakersMock, fetchQuoteStatsMock, fetchReferencePricesMock, getQuotesMock]) {
      expect(m).not.toHaveBeenCalled();
    }
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("reaches the h1 and the subtitle without passing through a Suspense element", () => {
    const hits = walkTree(EkonomiPage());

    const h1 = hits.find((h) => h.el.type === "h1");
    expect(h1).toBeDefined();
    expect(textOfNode(h1!.el.props.children)).toBe("Tayf Ekonomi");
    expect(h1!.inSuspense).toBe(false);

    const subtitle = hits.find((h) => h.el.type === "p" && textOfNode(h.el.props.children).startsWith("Haberde adı geçen hisseler"));
    expect(subtitle).toBeDefined();
    expect(subtitle!.inSuspense).toBe(false);
    expect(subtitle!.el.props.className).toBe("text-muted-foreground");
    expect(textOfNode(subtitle!.el.props.children)).toContain("Yatırım tavsiyesi değildir.");
  });

  it("puts EkonomiBody inside a Suspense element, and nothing else data-driven anywhere in the shell", () => {
    const hits = walkTree(EkonomiPage());

    const body = hits.filter((h) => h.el.type === EkonomiBody);
    expect(body).toHaveLength(1);
    expect(body[0]!.inSuspense).toBe(true);
    // The shell holds no data component: the body is the only function-typed child.
    const components = hits.filter((h) => typeof h.el.type === "function" && h.el.type !== Suspense);
    expect(components.map((h) => h.el.type)).toEqual([EkonomiBody]);
  });

  it("the body's boundary is the shell's only Suspense, and its fallback is the shared skeleton", () => {
    const suspenses = walkTree(EkonomiPage()).filter((h) => h.el.type === Suspense);

    expect(suspenses).toHaveLength(1);
    const [bodyBoundary] = suspenses;
    expect((bodyBoundary!.el.props.fallback as { type: unknown }).type).toBe(EkonomiBodySkeleton);
  });

  it("the header row is fully static: no Suspense and no component inside it, so nothing can grow it after first paint", () => {
    const tree = EkonomiPage() as unknown as { props: { children: unknown[] } };
    const [row] = tree.props.children as El[];

    const inside = walkTree(row!.props.children);
    expect(inside.length).toBeGreaterThan(0);
    for (const h of inside) {
      expect(h.el.type === Suspense, "Suspense").toBe(false);
      expect(typeof h.el.type, String(h.el.type)).not.toBe("function");
    }
    // Plain host elements only: the h1 (with its brand span) and the subtitle column.
    expect(inside.map((h) => h.el.type)).toEqual(["h1", "span", "div", "p"]);
  });

  it("keeps the header markup of the loaded page: outer div, header row, h1, then the subtitle as the right column's only child", () => {
    const tree = EkonomiPage() as unknown as { props: { className: string; children: unknown[] } };

    expect(tree.props.className).toBe("mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3");
    const [row, rest] = tree.props.children as Array<{ type: unknown; props: { className?: string; children: unknown[] } }>;
    expect(row!.type).toBe("div");
    expect(row!.props.className).toBe("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[12px]");
    const [h1, right] = row!.props.children as Array<{ type: unknown; props: { className?: string; children: unknown } }>;
    expect(h1!.type).toBe("h1");
    expect(h1!.props.className).toBe("font-mono text-[12px] font-normal text-foreground");
    expect(right!.type).toBe("div");
    expect(right!.props.className).toBe("space-y-0.5");
    // One child, not an array: the subtitle. The market cue is no longer a sibling of it.
    expect(Array.isArray(right!.props.children)).toBe(false);
    const subtitle = right!.props.children as { type: unknown; props: { className?: string } };
    expect(subtitle.type).toBe("p");
    expect(subtitle.props.className).toBe("text-muted-foreground");
    expect((rest as unknown as { type: unknown }).type).toBe(Suspense);
  });
});

// ---------------------------------------------------------------------------
// h101-a11yrecent-2 (WCAG 3.1.2 Language of Parts): the feed's headlines and source names are plain text under
// <html lang="tr">. Items from an English outlet (Daily Sabah, Hürriyet Daily News, TRT World, A News, ...) must
// carry lang="en" on the headline text and on the source-name span, the way every other surface wired through
// sourceLang() does; a Turkish outlet's row renders no attribute. The lang sits on an inner span around the title,
// not on the anchor: the anchor also holds <NewTabHint />, a Turkish sr-only cue that must not inherit "en". The
// page is a server component, so these read the element tree.
// ---------------------------------------------------------------------------
describe("/ekonomi -- feed rows mark an English outlet's text (h101-a11yrecent-2)", () => {
  const row = (id: string, source: { name: string; slug: string } | null, title: string) => ({
    id,
    title,
    url: `https://example.com/${id}`,
    publishedAt: "2026-11-05T08:00:00.000Z",
    category: "ekonomi",
    source,
    tickers: ["THYAO"],
  });
  const EN_TITLE = "Turkish Airlines posts $1.3 billion net income in third quarter";
  const TR_TITLE = "THY üçüncü çeyrekte 1,3 milyar dolar net kâr açıkladı";

  const anchorFor = (els: El[], id: string) => els.find((e) => e.type === "a" && e.props.href === `https://example.com/${id}`);
  /** The anchor's direct children as an array (React leaves a single child unwrapped). */
  const kidsOf = (a: El) => ([] as unknown[]).concat(a.props.children ?? []) as El[];
  /** The anchor's child span that prints the headline. */
  const titleSpanOf = (a: El, title: string) =>
    kidsOf(a).find((k) => k.type === "span" && textOfEl(k.props.children) === title);
  /** The anchor's direct <NewTabHint /> children. */
  const hintsOf = (a: El) => kidsOf(a).filter((k) => k.type === NewTabHint);
  /** The two spans that print a source name (the sm:block cell and the sm:hidden chip-row copy). */
  const nameSpans = (els: El[], name: string) =>
    els.filter((e) => e.type === "span" && textOfEl(e.props.children) === name);

  function textOfEl(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOfEl).join("");
    return textOfEl((node as { props?: { children?: unknown } }).props?.children);
  }

  it("a Daily Sabah row: the headline text span and both source-name spans are lang=\"en\", the anchor is not", async () => {
    fetchEconFeedMock.mockResolvedValue([row("e1", { name: "Daily Sabah", slug: "daily-sabah" }, EN_TITLE)]);

    const els = await render();

    const a = anchorFor(els, "e1")!;
    expect(a.props.lang).toBeUndefined();
    const title = titleSpanOf(a, EN_TITLE);
    expect(title).toBeDefined();
    expect(title!.props.lang).toBe("en");
    // The Turkish new-tab cue is a direct child of the anchor, outside the English span.
    expect(title!.props.children).toBe(EN_TITLE);
    expect(hintsOf(a)).toHaveLength(1);
    const spans = nameSpans(els, "Daily Sabah");
    // The desktop cell (hidden below sm) and the phone copy inside the chip row (hidden from sm).
    expect(spans.map((s) => String(s.props.className).includes("sm:block") || String(s.props.className).includes("sm:hidden"))).toEqual([true, true]);
    for (const s of spans) expect(s.props.lang).toBe("en");
  });

  it("a Hürriyet Daily News row is English too", async () => {
    fetchEconFeedMock.mockResolvedValue([row("e2", { name: "Hürriyet Daily News", slug: "hurriyet-daily-news" }, EN_TITLE)]);

    const els = await render();

    const a = anchorFor(els, "e2")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, EN_TITLE)!.props.lang).toBe("en");
    expect(hintsOf(a)).toHaveLength(1);
    for (const s of nameSpans(els, "Hürriyet Daily News")) expect(s.props.lang).toBe("en");
  });

  it("a Sözcü row renders no lang attribute on the link, the title span or either source-name span", async () => {
    fetchEconFeedMock.mockResolvedValue([row("t1", { name: "Sözcü", slug: "sozcu" }, TR_TITLE)]);

    const els = await render();

    const a = anchorFor(els, "t1")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, TR_TITLE)!.props.lang).toBeUndefined();
    expect(hintsOf(a)).toHaveLength(1);
    const spans = nameSpans(els, "Sözcü");
    expect(spans).toHaveLength(2);
    for (const s of spans) expect(s.props.lang).toBeUndefined();
  });

  it("the slug decides: a row whose slug is Turkish but whose name reads like an English outlet is not marked", async () => {
    fetchEconFeedMock.mockResolvedValue([row("t2", { name: "Daily Sabah", slug: "sozcu" }, TR_TITLE)]);

    const a = anchorFor(await render(), "t2")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, TR_TITLE)!.props.lang).toBeUndefined();
  });

  it("a mixed feed marks only the English row", async () => {
    fetchEconFeedMock.mockResolvedValue([
      row("e1", { name: "Daily Sabah", slug: "daily-sabah" }, EN_TITLE),
      row("t1", { name: "Sözcü", slug: "sozcu" }, TR_TITLE),
    ]);

    const els = await render();

    expect(titleSpanOf(anchorFor(els, "e1")!, EN_TITLE)!.props.lang).toBe("en");
    expect(titleSpanOf(anchorFor(els, "t1")!, TR_TITLE)!.props.lang).toBeUndefined();
    expect(anchorFor(els, "e1")!.props.lang).toBeUndefined();
    expect(anchorFor(els, "t1")!.props.lang).toBeUndefined();
  });

  it("a row with no source still renders, with no lang on its link or its title span", async () => {
    fetchEconFeedMock.mockResolvedValue([row("n1", null, TR_TITLE)]);

    const els = await render();

    const a = anchorFor(els, "n1")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, TR_TITLE)!.props.lang).toBeUndefined();
    expect(hintsOf(a)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// h108-kapdisclosures-1: a rating agency files "Kredi Derecelendirmesi" under its own
// code (TRATE, JCRAV, SAHAR) for the company it rated. The feed's chips used to be the
// agency's (a link to /ekonomi/TRATE, a page with no company row); they are now the rated
// company's, and a muted marker after them says whose filing it is.
// ---------------------------------------------------------------------------
describe("/ekonomi -- a rating agency's notice is listed under the rated company (h108-kapdisclosures-1)", () => {
  const AGENCY_TITLE = "İSTANBUL ULUSLARARASI DERECELENDİRME HİZMETLERİ A.Ş.";
  const kapRow = (over: Record<string, unknown> = {}) => ({
    disclosureIndex: 1696754,
    publishedAt: "2026-11-05T09:58:00.000Z",
    kapTitle: AGENCY_TITLE,
    // What toDisclosure hands over for an agency-filed row: the rated company is the chip.
    stockCodes: ["DNYVA"],
    filerCodes: ["TRATE"],
    relatedCodes: ["DNYVA"],
    agencyFiled: true,
    subject: "Kredi Derecelendirmesi",
    summary: "Kredi Derecelendirme Notunun Askıya Alınması",
    disclosureClass: "ODA",
    modifyStatus: null,
    year: null,
    period: null,
    ruleType: null,
    ...over,
  });

  function textOfEl(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOfEl).join("");
    return textOfEl((node as { props?: { children?: unknown } }).props?.children);
  }
  const chipHrefs = (els: El[]) => els.filter((e) => typeof e.props.href === "string" && String(e.props.href).startsWith("/ekonomi/")).map((e) => e.props.href);
  const filerSpans = (els: El[]) => els.filter((e) => e.type === "span" && /bildirimi$/.test(textOfEl(e.props.children)));

  it("links the rated company, not the agency, and names the agency after the chips", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow()]);

    const els = await render();

    expect(chipHrefs(els)).toContain("/ekonomi/DNYVA");
    expect(chipHrefs(els)).not.toContain("/ekonomi/TRATE");
    const spans = filerSpans(els);
    expect(spans).toHaveLength(1);
    expect(textOfEl(spans[0]!.props.children)).toBe("· İstanbul Uluslararası Derecelendirme Hizmetleri bildirimi");
    expect(String(spans[0]!.props.className)).toContain("text-muted-foreground");
  });

  it("the marker comes after the last chip in the row", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow({ stockCodes: ["DNYVA", "DNYVB"], relatedCodes: ["DNYVA", "DNYVB"] })]);

    const els = await render();

    const order = els
      .filter((e) => (typeof e.props.href === "string" && String(e.props.href).startsWith("/ekonomi/D")) || (e.type === "span" && /bildirimi$/.test(textOfEl(e.props.children))))
      .map((e) => (e.type === "span" ? "marker" : String(e.props.href)));
    expect(order).toEqual(["/ekonomi/DNYVA", "/ekonomi/DNYVB", "marker"]);
  });

  it("falls back to the filer's code when KAP gave no usable title", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow({ kapTitle: null, filerCodes: ["TRATE", "JCRAV"] })]);

    const spans = filerSpans(await render());

    expect(spans.map((s) => textOfEl(s.props.children))).toEqual(["· TRATE, JCRAV bildirimi"]);
  });

  it("a company's own filing and a related-only notice carry no marker", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([
      kapRow({ disclosureIndex: 1, kapTitle: "ZORLU ENERJİ A.Ş.", stockCodes: ["ZOREN"], filerCodes: ["ZOREN"], relatedCodes: [], agencyFiled: false }),
      kapRow({ disclosureIndex: 2, kapTitle: "NET HOLDİNG A.Ş.", stockCodes: ["NTHOL"], filerCodes: ["NTHOL"], relatedCodes: ["MERIT"], agencyFiled: false, subject: "Pay Alım Satım Bildirimi" }),
      kapRow({ disclosureIndex: 3, kapTitle: "TAKASBANK", stockCodes: ["X"], filerCodes: [], relatedCodes: ["X"], agencyFiled: false, subject: "Temerrüt İşlemi" }),
    ]);

    const els = await render();

    expect(filerSpans(els)).toHaveLength(0);
    expect(chipHrefs(els)).toEqual(expect.arrayContaining(["/ekonomi/ZOREN", "/ekonomi/NTHOL", "/ekonomi/X"]));
  });
});

// ---------------------------------------------------------------------------
// h108-kapdisclosures-4: the feed's class labels follow KAP's taxonomy. DG ("Diğer": standing
// forms and reports) used to read "duyuru" and DKB ("Düzenleyici Kurum Bildirimi": exchange, MKK,
// Takasbank, SPK notices) "diğer".
// ---------------------------------------------------------------------------
describe("/ekonomi -- KAP class labels match KAP's taxonomy (h108-kapdisclosures-4)", () => {
  const kapRow = (index: number, disclosureClass: string | null, subject: string) => ({
    disclosureIndex: index,
    publishedAt: "2026-11-05T09:58:00.000Z",
    kapTitle: "DENGE YATIRIM HOLDİNG A.Ş.",
    stockCodes: ["DENGE"],
    filerCodes: ["DENGE"],
    relatedCodes: [] as string[],
    agencyFiled: false,
    subject,
    summary: null,
    disclosureClass,
    modifyStatus: null,
    year: null,
    period: null,
    ruleType: null,
  });
  function textOfEl(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOfEl).join("");
    return textOfEl((node as { props?: { children?: unknown } }).props?.children);
  }
  const labelOf = (els: El[], subject: string) => {
    // The class label is the span just before the subject link inside the row's chip line.
    const line = els.find(
      (e) => e.type === "div" && String(e.props.className ?? "").includes("flex-wrap") && textOfEl(e.props.children).includes(subject),
    );
    const spans = collectEls(line?.props.children).filter((e) => e.type === "span" && String(e.props.className ?? "").includes("text-"));
    return spans.map((s) => textOfEl(s.props.children)).find((t) => ["diğer", "düzenleyici kurum", "finansal rapor", "özel durum", "duyuru"].includes(t));
  };

  it("a DG row ('Şirket Genel Bilgi Formu') reads 'diğer', not 'duyuru'", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow(1, "DG", "Şirket Genel Bilgi Formu")]);
    expect(labelOf(await render(), "Şirket Genel Bilgi Formu")).toBe("diğer");
  });

  it("a DKB row ('MKK Duyurusu') reads 'düzenleyici kurum', not 'diğer'", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow(2, "DKB", "MKK Duyurusu")]);
    expect(labelOf(await render(), "MKK Duyurusu")).toBe("düzenleyici kurum");
  });

  it("FR and ODA keep their labels; FR stays amber, the rest muted", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow(3, "FR", "Finansal Rapor"), kapRow(4, "ODA", "Özel Durum Açıklaması (Genel)")]);
    const els = await render();
    expect(labelOf(els, "Finansal Rapor")).toBe("finansal rapor");
    expect(labelOf(els, "Özel Durum Açıklaması (Genel)")).toBe("özel durum");
    const fr = els.find((e) => e.type === "span" && textOfEl(e.props.children) === "finansal rapor")!;
    expect(String(fr.props.className)).toBe("text-amber-400");
    const oda = els.find((e) => e.type === "span" && textOfEl(e.props.children) === "özel durum")!;
    expect(String(oda.props.className)).toBe("text-muted-foreground");
  });

  it("an unknown class prints its lower-case code and a null class prints nothing", async () => {
    fetchRecentDisclosuresMock.mockResolvedValue([kapRow(5, "XYZ", "Bir Konu"), kapRow(6, null, "Başka Konu")]);
    const els = await render();
    expect(els.some((e) => e.type === "span" && textOfEl(e.props.children) === "xyz")).toBe(true);
    const other = els.find((e) => e.type === "div" && String(e.props.className ?? "").includes("flex-wrap") && textOfEl(e.props.children).includes("Başka Konu"));
    expect(collectEls(other?.props.children).some((e) => e.type === "span" && ["diğer", "duyuru", "düzenleyici kurum"].includes(textOfEl(e.props.children)))).toBe(false);
  });
});
