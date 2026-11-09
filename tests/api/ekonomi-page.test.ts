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

import EkonomiPage from "@/app/ekonomi/page";
import { BreakerStrip } from "@/components/finance/breaker-strip";
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
  return collectEls(await EkonomiPage());
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
  it("fetchEconFeed rejecting rejects the page with that error", async () => {
    const boom = new Error("[finance] fetchEconFeed: statement timeout");
    fetchEconFeedMock.mockRejectedValue(boom);

    await expect(EkonomiPage()).rejects.toBe(boom);
    expect(warn).not.toHaveBeenCalled();
    // Without the feed there is no ticker set to quote.
    expect(getQuotesMock).not.toHaveBeenCalled();
  });

  it("fetchTopTickers rejecting rejects the page", async () => {
    fetchTopTickersMock.mockRejectedValue(new Error("[finance] fetchTopTickers: statement timeout"));

    await expect(EkonomiPage()).rejects.toThrow("fetchTopTickers");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fetchRecentDisclosures rejecting rejects the page", async () => {
    fetchRecentDisclosuresMock.mockRejectedValue(new Error("[finance] fetchRecentDisclosures: statement timeout"));

    await expect(EkonomiPage()).rejects.toThrow("fetchRecentDisclosures");
    expect(warn).not.toHaveBeenCalled();
  });

  it("an essential failure together with a decorative one still rejects, with no unhandled rejection", async () => {
    const boom = new Error("[finance] fetchEconFeed: statement timeout");
    fetchEconFeedMock.mockRejectedValue(boom);
    fetchCircuitBreakersMock.mockRejectedValue(new Error("breakers down too"));

    await expect(EkonomiPage()).rejects.toBe(boom);
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
