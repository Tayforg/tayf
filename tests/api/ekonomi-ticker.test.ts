import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Pack E / worker E2 — SEC-04/SEC-11 for /ekonomi/[ticker].
//
// The page previously ran the full (heavy) fetchTickerPage() before deciding
// notFound(), and did so after connection() had already opted the segment
// into the loading.tsx-backed dynamic Suspense boundary. The fix adds a
// cheap existence probe (bist_companies, falling back to article_tickers /
// kap_disclosures on a company-row miss — see page.tsx's tickerExists()
// header comment) that runs, and can notFound(), BEFORE connection() and
// before any quote/bars fetch.
//
// This suite proves: (1) the call ORDER — for a ticker with no coverage
// anywhere, notFound() is called and none of fetchTickerPage /
// fetchQuoteStats / fetchIntraday / getQuotes ever run; (2) the existence
// fallback — a ticker with article/disclosure coverage but no company row
// must NOT 404. It does not assert an HTTP status: under cacheComponents/
// PPR a well-formed-but-unknown ticker still streams a 200 shell (see
// src/middleware.ts for the wire-level shape gate, and page.tsx's
// tickerExists() header comment for the measured detail).
//
// Cold-read resilience: the probe runs under the 4 s reader cap
// (createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS })) and has three
// outcomes, not two. A timeout/error is NEVER a 404: "missing" (every probe
// answered, none found the ticker) calls notFound(); "unknown" (a probe
// errored/timed out and nothing else proved the ticker exists) throws a plain
// Error so src/app/ekonomi/error.tsx renders ("Tekrar dene") and the metadata
// is noindex without claiming "Hisse bulunamadı".
//
// h11 (finance 1/3/4): the probe's company read now also selects shares_traded
// (a thin ticker -- no company row, shares_traded false, a code under 4
// characters, KTEST -- is noindex,follow), its kap_disclosures fallback uses
// the combined stock_codes-OR-related_stocks or() string, the not-found and
// unknown shells carry `alternates: { canonical: null }`, and the page shows
// the ticker's latest trading-halt notice beside the price. Those are pinned at
// the bottom of this file.
//
// next/navigation.notFound() normally throws (a special Next digest error)
// to unwind the render; the fake here throws too so a test that forgets to
// account for the early-return would fail loudly instead of quietly
// continuing into the mocked fetchers.
// ---------------------------------------------------------------------------

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

// vi.mock(...) factories are hoisted above every other top-level statement
// in this file, so any mock fn / mutable state they close over has to be
// created via vi.hoisted() — a plain `const x = vi.fn()` above the
// vi.mock() call would still be in its temporal dead zone when the hoisted
// factory runs (see tests/api/admin.test.ts for the same pattern).
const {
  notFoundMock,
  connectionMock,
  fetchTickerPageMock,
  fetchQuoteStatsMock,
  fetchIntradayMock,
  getQuotesMock,
  companyProbeMock,
  articlesProbeMock,
  disclosuresProbeMock,
  probeState,
  probeLog,
  createFinanceClientMock,
} = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new NotFoundSignal();
  }),
  connectionMock: vi.fn(async () => undefined),
  fetchTickerPageMock: vi.fn(),
  fetchQuoteStatsMock: vi.fn(),
  fetchIntradayMock: vi.fn(),
  getQuotesMock: vi.fn(),
  // tickerExists() (page.tsx) probes bist_companies first
  // (`.contains().limit()`), and only on a miss, article_tickers
  // (`.eq().limit()`) and kap_disclosures (`.contains().limit()`) in
  // parallel. `probeState` is flipped per test to control each table's
  // result.
  companyProbeMock: vi.fn(),
  articlesProbeMock: vi.fn(),
  disclosuresProbeMock: vi.fn(),
  probeState: {
    company: { data: [] as unknown[] | null, error: null as { message: string } | null },
    articles: { data: [] as unknown[] | null, error: null as { message: string } | null },
    disclosures: { data: [] as unknown[] | null, error: null as { message: string } | null },
  },
  // What the probes were asked: the company select list and the kap_disclosures or() strings.
  probeLog: { companySelect: [] as string[], disclosureOr: [] as string[], disclosureContains: 0 },
  // createFinanceServerClient(opts) — async, resolves to the fake below.
  createFinanceClientMock: vi.fn(),
}));
companyProbeMock.mockImplementation(async () => probeState.company);
articlesProbeMock.mockImplementation(async () => probeState.articles);
disclosuresProbeMock.mockImplementation(async () => probeState.disclosures);

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  // The real unstable_rethrow only re-throws Next control-flow errors
  // (notFound/redirect/postpone/dynamic bailouts) and is a no-op for a plain
  // Error; the fake's only control-flow signal is NotFoundSignal.
  unstable_rethrow: (err: unknown) => {
    if (err instanceof NotFoundSignal) throw err;
  },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: connectionMock };
});

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

// kap-media-pickup: this file's @/lib/supabase/server mock below lacks
// createFinanceServerClient (used by getTickerPickup/kap-pickup-query),
// and the panel is purely additive to this page — stub it out so the
// existing assertions stay untouched and independent of the pickup path.
vi.mock("@/components/finance/kap-pickup-panel", () => ({
  KapPickupPanel: () => null,
}));

vi.mock("@/lib/finance/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance/queries")>();
  return {
    ...actual,
    fetchTickerPage: (...args: unknown[]) => fetchTickerPageMock(...args),
    fetchQuoteStats: (...args: unknown[]) => fetchQuoteStatsMock(...args),
    fetchIntraday: (...args: unknown[]) => fetchIntradayMock(...args),
  };
});

vi.mock("@/lib/finance/quotes", () => ({
  getQuotes: (...args: unknown[]) => getQuotesMock(...args),
}));

const fakeClient = {
  from: (table: string) => {
    if (table === "bist_companies") {
      return {
        select: (cols: string) => {
          probeLog.companySelect.push(cols);
          return { contains: (_col: string, _val: unknown[]) => ({ limit: companyProbeMock }) };
        },
      };
    }
    if (table === "article_tickers") {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: unknown) => ({ limit: articlesProbeMock }),
        }),
      };
    }
    // kap_disclosures: the probe sends ONE combined or() (stock_codes OR related_stocks);
    // a leftover .contains("stock_codes", ...) would count here.
    return {
      select: (_cols: string) => ({
        or: (filters: string) => {
          probeLog.disclosureOr.push(filters);
          return { limit: disclosuresProbeMock };
        },
        contains: (_col: string, _val: unknown[]) => {
          probeLog.disclosureContains += 1;
          return { limit: disclosuresProbeMock };
        },
      }),
    };
  },
};

vi.mock("@/lib/supabase/server", () => ({
  READER_TIMEOUT_MS: 4000,
  createFinanceServerClient: (opts?: unknown) => createFinanceClientMock(opts),
}));

import TickerPage, { generateMetadata } from "@/app/ekonomi/[ticker]/page";

beforeEach(() => {
  notFoundMock.mockClear();
  connectionMock.mockClear();
  fetchTickerPageMock.mockReset();
  fetchQuoteStatsMock.mockReset();
  fetchIntradayMock.mockReset();
  getQuotesMock.mockReset();
  companyProbeMock.mockClear();
  articlesProbeMock.mockClear();
  disclosuresProbeMock.mockClear();
  probeState.company = { data: [], error: null };
  probeState.articles = { data: [], error: null };
  probeState.disclosures = { data: [], error: null };
  probeLog.companySelect = [];
  probeLog.disclosureOr = [];
  probeLog.disclosureContains = 0;
  createFinanceClientMock.mockReset();
  createFinanceClientMock.mockImplementation(async () => fakeClient);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/ekonomi/[ticker] — existence-gated notFound() call order", () => {
  it("calls notFound() and never touches fetchTickerPage/quote/bars fetchers for a well-formed ticker with no coverage anywhere", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: [], error: null };
    const params = Promise.resolve({ ticker: "ZZZZZZ" });

    await expect(TickerPage({ params })).rejects.toThrow(NotFoundSignal);

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(fetchTickerPageMock).not.toHaveBeenCalled();
    expect(fetchQuoteStatsMock).not.toHaveBeenCalled();
    expect(fetchIntradayMock).not.toHaveBeenCalled();
    expect(getQuotesMock).not.toHaveBeenCalled();
  });

  it("calls notFound() for a malformed ticker shape without ever probing the database", async () => {
    const params = Promise.resolve({ ticker: "does-not-exist-way-too-long" });

    await expect(TickerPage({ params })).rejects.toThrow(NotFoundSignal);

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(companyProbeMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).not.toHaveBeenCalled();
  });

  it("proceeds past the existence gate (and only then calls connection()) when the company row exists", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1" }], error: null };
    fetchTickerPageMock.mockResolvedValue({
      company: { kapMemberOid: "kap-1", tickers: ["ASELS"], title: "ASELSAN", city: "Ankara", sharesTraded: true },
      attention: [],
      articles: [],
      articlesTruncated: false,
      disclosures: [],
      totalDisclosures30d: 0,
      coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
    });
    fetchQuoteStatsMock.mockResolvedValue({});
    fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });
    getQuotesMock.mockResolvedValue({});

    const params = Promise.resolve({ ticker: "asels" });
    await TickerPage({ params });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(connectionMock).toHaveBeenCalledTimes(1);
    expect(fetchTickerPageMock).toHaveBeenCalledWith("ASELS");
  });

  // E-06: a company-row miss is not final — a freshly listed or aliased
  // ticker, or one stuck behind the company-sync breaker's up-to-6h
  // window, can still have real article or disclosure coverage. That must
  // render its coverage, not 404.
  it("does not call notFound() when the company row is missing but the ticker has article coverage", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [{ ticker: "ZZZZZZ" }], error: null };
    probeState.disclosures = { data: [], error: null };
    fetchTickerPageMock.mockResolvedValue({
      company: null,
      attention: [],
      articles: [],
      articlesTruncated: false,
      disclosures: [],
      totalDisclosures30d: 0,
      coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
    });
    fetchQuoteStatsMock.mockResolvedValue({});
    fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });
    getQuotesMock.mockResolvedValue({});

    const params = Promise.resolve({ ticker: "ZZZZZZ" });
    await TickerPage({ params });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).toHaveBeenCalledWith("ZZZZZZ");
  });

  it("does not call notFound() when the company row is missing but the ticker has KAP disclosure coverage", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: [{ disclosure_index: 42 }], error: null };
    fetchTickerPageMock.mockResolvedValue({
      company: null,
      attention: [],
      articles: [],
      articlesTruncated: false,
      disclosures: [],
      totalDisclosures30d: 0,
      coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
    });
    fetchQuoteStatsMock.mockResolvedValue({});
    fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });
    getQuotesMock.mockResolvedValue({});

    const params = Promise.resolve({ ticker: "ZZZZZZ" });
    await TickerPage({ params });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).toHaveBeenCalledWith("ZZZZZZ");
  });
});

describe("generateMetadata — neutral title for a ticker with no coverage", () => {
  it("returns a neutral, non-indexed title for a malformed ticker without reflecting the raw param", async () => {
    const raw = "<script>alert(1)</script>";
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: raw }) });
    expect(metadata.title).toBe("Hisse bulunamadı");
    expect(JSON.stringify(metadata)).not.toContain(raw);
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("returns the same neutral title for a well-formed ticker with no coverage anywhere", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: [], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(metadata.title).toBe("Hisse bulunamadı");
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("returns the real ticker title once the company row is confirmed", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "asels" }) });
    expect(metadata.title).toBe("ASELS — hisse haberleri ve KAP bildirimleri");
  });

  // Share identity: without its own openGraph/twitter, a shared
  // /ekonomi/LYDHO link unfurled with the homepage's og:url '/' and title.
  it("gives a confirmed ticker its own og:url, og:title and twitter card (not the homepage's)", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "lydho" }) });

    const title = "LYDHO — hisse haberleri ve KAP bildirimleri";
    expect(metadata.alternates?.canonical).toBe("/ekonomi/LYDHO");
    expect(metadata.openGraph).toMatchObject({
      url: "/ekonomi/LYDHO",
      title: `${title} — Tayf`,
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: `${title} — Tayf`,
    });
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.robots).toBeUndefined();
  });

  it("keeps the root share images on a confirmed ticker", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "LYDHO" }) });
    const og = metadata.openGraph as { images?: { url: string }[] } | null | undefined;
    const tw = metadata.twitter as { images?: { url: string }[] } | null | undefined;
    expect(og?.images?.[0]?.url).toBe("/opengraph-image");
    expect(tw?.images?.[0]?.url).toBe("/twitter-image");
  });

  it("does not give the not-found or unknown shells an og:url (they stay noindex and unshared)", async () => {
    const missing = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(missing.openGraph).toBeUndefined();
    expect(missing.twitter).toBeUndefined();

    probeState.company = { data: null, error: TIMEOUT };
    const unknown = await generateMetadata({ params: Promise.resolve({ ticker: "ASELS" }) });
    expect(unknown.openGraph).toBeUndefined();
    expect(unknown.twitter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience: a timeout is not a 404.
// ---------------------------------------------------------------------------

const TIMEOUT = {
  message: "AbortError: Supabase request exceeded 4000 ms",
  hint: "Request was aborted (timeout or manual cancellation)",
  code: "",
};

function stubRenderableTickerPage() {
  fetchTickerPageMock.mockResolvedValue({
    company: null,
    attention: [],
    articles: [],
    articlesTruncated: false,
    disclosures: [],
    totalDisclosures30d: 0,
    coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
  });
  fetchQuoteStatsMock.mockResolvedValue({});
  fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });
  getQuotesMock.mockResolvedValue({});
}

describe("/ekonomi/[ticker] — existence probe under the reader cap", () => {
  it("creates the finance client with the 4 s reader timeout", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1" }], error: null };
    stubRenderableTickerPage();

    await TickerPage({ params: Promise.resolve({ ticker: "ASELS" }) });

    expect(createFinanceClientMock).toHaveBeenCalledTimes(1);
    expect(createFinanceClientMock).toHaveBeenCalledWith({ timeoutMs: 4000 });
  });

  it("the page and generateMetadata share one probe set (React cache dedupes by ticker)", async () => {
    // Outside an RSC render React's cache() is a pass-through, so this only
    // pins the cap: every client the probe builds is created with the timeout.
    probeState.company = { data: [{ kap_member_oid: "kap-1" }], error: null };
    await generateMetadata({ params: Promise.resolve({ ticker: "ASELS" }) });
    for (const call of createFinanceClientMock.mock.calls) {
      expect(call[0]).toEqual({ timeoutMs: 4000 });
    }
  });
});

describe("/ekonomi/[ticker] — a timeout is not a 404 (page)", () => {
  it("a company-probe AbortError rejects with a plain Error: no notFound(), no fetchTickerPage, no connection()", async () => {
    probeState.company = { data: null, error: TIMEOUT };

    const result = TickerPage({ params: Promise.resolve({ ticker: "ASELS" }) });
    await expect(result).rejects.toThrow("[ekonomi] ticker existence unknown: ASELS");
    await expect(result).rejects.not.toBeInstanceOf(NotFoundSignal);

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).not.toHaveBeenCalled();
    expect(connectionMock).not.toHaveBeenCalled();
    // The company probe failing short-circuits: no point probing further.
    expect(articlesProbeMock).not.toHaveBeenCalled();
    expect(disclosuresProbeMock).not.toHaveBeenCalled();
  });

  it("company miss + articles probe timeout + empty disclosures rejects and does not 404", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: null, error: TIMEOUT };
    probeState.disclosures = { data: [], error: null };

    await expect(
      TickerPage({ params: Promise.resolve({ ticker: "ZZZZZZ" }) }),
    ).rejects.toThrow("[ekonomi] ticker existence unknown: ZZZZZZ");

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).not.toHaveBeenCalled();
    expect(connectionMock).not.toHaveBeenCalled();
  });

  it("company miss + empty articles + disclosures probe timeout also rejects and does not 404", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: null, error: TIMEOUT };

    await expect(
      TickerPage({ params: Promise.resolve({ ticker: "ZZZZZZ" }) }),
    ).rejects.toThrow("[ekonomi] ticker existence unknown: ZZZZZZ");

    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("company miss + articles ERROR + a disclosure row present renders: positive evidence beats a failed sibling probe", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: null, error: TIMEOUT };
    probeState.disclosures = { data: [{ disclosure_index: 42 }], error: null };
    stubRenderableTickerPage();

    await TickerPage({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(connectionMock).toHaveBeenCalledTimes(1);
    expect(fetchTickerPageMock).toHaveBeenCalledWith("ZZZZZZ");
  });

  it("company miss + an article row + disclosures ERROR renders too", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [{ ticker: "ZZZZZZ" }], error: null };
    probeState.disclosures = { data: null, error: TIMEOUT };
    stubRenderableTickerPage();

    await TickerPage({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(fetchTickerPageMock).toHaveBeenCalledWith("ZZZZZZ");
  });

  it("all three probes answering empty is the only way to a 404", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: [], error: null };

    await expect(
      TickerPage({ params: Promise.resolve({ ticker: "ZZZZZZ" }) }),
    ).rejects.toThrow(NotFoundSignal);

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(connectionMock).not.toHaveBeenCalled();
  });

  it("a thrown client construction (missing env) is unknown, not a 404", async () => {
    createFinanceClientMock.mockRejectedValue(new Error("Missing NEXT_PUBLIC_SUPABASE_URL"));

    await expect(
      TickerPage({ params: Promise.resolve({ ticker: "ASELS" }) }),
    ).rejects.toThrow("[ekonomi] ticker existence unknown: ASELS");

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(companyProbeMock).not.toHaveBeenCalled();
  });

  it("a probe that throws (rather than returning an error envelope) is unknown, not a 404", async () => {
    companyProbeMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(
      TickerPage({ params: Promise.resolve({ ticker: "ASELS" }) }),
    ).rejects.toThrow("[ekonomi] ticker existence unknown: ASELS");

    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

describe("generateMetadata — a timeout is not 'Hisse bulunamadı'", () => {
  it("returns a noindex, non-'not found' title when the existence probe is unknown", async () => {
    probeState.company = { data: null, error: TIMEOUT };

    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ASELS" }) });

    expect(metadata.title).toBe("Hisse sayfası şu anda yüklenemiyor");
    expect(metadata.title).not.toBe("Hisse bulunamadı");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    // Not undefined: the layout's site-wide canonical '/' would leak into the shell otherwise.
    expect(metadata.alternates).toEqual({ canonical: null });
  });

  it("an unknown probe in the fallback tier is also not reported as missing", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: null, error: TIMEOUT };

    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });

    expect(metadata.title).not.toBe("Hisse bulunamadı");
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("still returns the missing-ticker metadata only when every probe answered empty", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(metadata.title).toBe("Hisse bulunamadı");
  });
});

// ---------------------------------------------------------------------------
// h11 (finance 1/3/4)
// ---------------------------------------------------------------------------

import { tickerDisclosureOr } from "@/lib/finance/disclosure-filter";

describe("probe filters (h11-finance-1)", () => {
  it("the company probe selects kap_member_oid,shares_traded,title", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true, title: "TÜRK HAVA YOLLARI A.O." }], error: null };
    await generateMetadata({ params: Promise.resolve({ ticker: "THYAO" }) });
    expect(probeLog.companySelect).toEqual(["kap_member_oid,shares_traded,title"]);
  });

  it("the kap_disclosures fallback probe sends the combined stock_codes OR related_stocks or(), never contains()", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [], error: null };
    probeState.disclosures = { data: [{ disclosure_index: 1688666 }], error: null };
    stubRenderableTickerPage();

    // TRHOL halt notices are tagged only in related_stocks: they alone must keep the page alive.
    await TickerPage({ params: Promise.resolve({ ticker: "TRHOL" }) });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(probeLog.disclosureOr).toEqual([tickerDisclosureOr("TRHOL")]);
    expect(probeLog.disclosureContains).toBe(0);
  });
});

describe("generateMetadata — error shells and thin tickers (h11-finance-4)", () => {
  it("the not-found shell has no canonical (alternates.canonical is null, not undefined)", async () => {
    const malformed = await generateMetadata({ params: Promise.resolve({ ticker: "<b>" }) });
    expect(malformed.alternates).toEqual({ canonical: null });
    expect(malformed.robots).toEqual({ index: false, follow: false });

    const missing = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(missing.title).toBe("Hisse bulunamadı");
    expect(missing.alternates).toEqual({ canonical: null });
    expect(missing.robots).toEqual({ index: false, follow: false });
  });

  it("a traded 4+ character ticker stays indexable: no robots, self canonical", async () => {
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    const m = await generateMetadata({ params: Promise.resolve({ ticker: "THYAO" }) });
    expect(m.robots).toBeUndefined();
    expect(m.alternates?.canonical).toBe("/ekonomi/THYAO");
  });

  it.each([
    ["KTEST (KAP's test company, shares_traded true)", "KTEST", { kap_member_oid: "k", shares_traded: true }],
    ["TGB (3 characters)", "TGB", { kap_member_oid: "k", shares_traded: true }],
    ["BOYNR (shares_traded false)", "BOYNR", { kap_member_oid: "k", shares_traded: false }],
    ["a company row without the flag", "ASELS", { kap_member_oid: "k" }],
  ])("%s is noindex,follow with its normal share metadata", async (_label, ticker, row) => {
    probeState.company = { data: [row], error: null };
    const m = await generateMetadata({ params: Promise.resolve({ ticker }) });
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.title).toBe(`${ticker} — hisse haberleri ve KAP bildirimleri`);
    expect(m.alternates?.canonical).toBe(`/ekonomi/${ticker}`);
    expect(m.openGraph).toMatchObject({ url: `/ekonomi/${ticker}` });
  });

  it("KOZAL (no company row, only article coverage) is noindex,follow", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [{ ticker: "KOZAL" }], error: null };
    const m = await generateMetadata({ params: Promise.resolve({ ticker: "KOZAL" }) });
    expect(m.robots).toEqual({ index: false, follow: true });
  });
});

// ---------------------------------------------------------------------------
// hunt-17: the title, the description and the H1 name the company.
// ---------------------------------------------------------------------------

describe("generateMetadata — names the company (hunt-17)", () => {
  it("puts the short company name in the title, the description and the share cards", async () => {
    probeState.company = { data: [{ kap_member_oid: "k", shares_traded: true, title: "ARÇELİK A.Ş." }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "arclk" }) });

    const title = "Arçelik (ARCLK) hisse haberleri ve KAP bildirimleri";
    expect(metadata.title).toBe(title);
    expect(metadata.description).toBe(
      "Arçelik (ARCLK) hissesini anan haberler, son fiyat, 30 günlük basın ilgisi ve KAP bildirimleri.",
    );
    expect(metadata.openGraph).toMatchObject({ url: "/ekonomi/ARCLK", title: `${title} — Tayf` });
    expect(metadata.twitter).toMatchObject({ title: `${title} — Tayf` });
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.alternates?.canonical).toBe("/ekonomi/ARCLK");
    expect(metadata.robots).toBeUndefined();
  });

  it("keeps an acronym and the Turkish capitals in the name (BİM Birleşik Mağazalar)", async () => {
    probeState.company = { data: [{ kap_member_oid: "k", shares_traded: true, title: "BİM BİRLEŞİK MAĞAZALAR A.Ş." }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "BIMAS" }) });
    expect(String(metadata.title).startsWith("BİM Birleşik Mağazalar (BIMAS)")).toBe(true);
    expect(metadata.title).toBe("BİM Birleşik Mağazalar (BIMAS) hisse haberleri ve KAP bildirimleri");
  });

  it("names the company on a thin (noindex) page too, and keeps its robots", async () => {
    probeState.company = { data: [{ kap_member_oid: "k", shares_traded: true, title: "KAP TEST A.Ş." }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "KTEST" }) });
    expect(metadata.title).toBe("KAP Test (KTEST) hisse haberleri ve KAP bildirimleri");
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/ekonomi/KTEST");
  });

  it.each([
    ["a row without a title", { kap_member_oid: "k", shares_traded: true }],
    ["a null title", { kap_member_oid: "k", shares_traded: true, title: null }],
    ["a non-string title", { kap_member_oid: "k", shares_traded: true, title: 7 }],
    ["a title that is only a legal form", { kap_member_oid: "k", shares_traded: true, title: "A.Ş." }],
    ["a blank title", { kap_member_oid: "k", shares_traded: true, title: "   " }],
  ])("falls back to the ticker-only strings for %s", async (_label, row) => {
    probeState.company = { data: [row], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ASELS" }) });
    expect(metadata.title).toBe("ASELS — hisse haberleri ve KAP bildirimleri");
    expect(metadata.description).toBe("ASELS hissesini anan haberler, son fiyat, 30 günlük basın ilgisi ve KAP bildirimleri.");
    expect(metadata.robots).toBeUndefined();
  });

  it("falls back to the ticker-only strings for a ticker that has no company row", async () => {
    probeState.company = { data: [], error: null };
    probeState.articles = { data: [{ ticker: "ZZZZZZ" }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(metadata.title).toBe("ZZZZZZ — hisse haberleri ve KAP bildirimleri");
    expect(metadata.description).toBe("ZZZZZZ hissesini anan haberler, son fiyat, 30 günlük basın ilgisi ve KAP bildirimleri.");
  });

  it("never puts the company name into the not-found or unknown shells", async () => {
    probeState.company = { data: [], error: null };
    const missing = await generateMetadata({ params: Promise.resolve({ ticker: "ZZZZZZ" }) });
    expect(missing.title).toBe("Hisse bulunamadı");
    expect(missing.description).toBeUndefined();

    probeState.company = { data: null, error: TIMEOUT };
    const unknown = await generateMetadata({ params: Promise.resolve({ ticker: "ARCLK" }) });
    expect(unknown.title).toBe("Hisse sayfası şu anda yüklenemiyor");
    expect(unknown.description).toBeUndefined();
  });
});

// --- what the page renders --------------------------------------------------

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

function textOfNode(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join("");
  return textOfNode((node as { props?: { children?: unknown } }).props?.children);
}

const panelMeta = (els: El[], title: string) => els.find((e) => e.props.title === title)?.props.meta;

const HALT_LINK = "https://www.kap.org.tr/tr/Bildirim/1688666";
const haltNotice = (over: Record<string, unknown> = {}) => ({
  disclosureIndex: 1688666,
  publishedAt: "2026-10-28T06:38:59Z",
  kapTitle: "BORSA İSTANBUL A.Ş.",
  stockCodes: ["TRHOL"],
  subject: "Pay İşlem Sırası Kapatma / Açma",
  summary: "Pay Sırasının İşleme Kapatılması",
  disclosureClass: null,
  ...over,
});
const trholQuote = (asOf: string) => ({
  TRHOL: { ticker: "TRHOL", price: 192, prevClose: 192, changePct: 0, hasBaseline: true, closes: [192, 192], currency: "TRY", asOf },
});

async function renderTicker(ticker: string, page: Record<string, unknown>, quotes: Record<string, unknown> = {}) {
  probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
  fetchTickerPageMock.mockResolvedValue({
    company: { kapMemberOid: "kap-1", tickers: [ticker], title: "X A.Ş.", city: "İstanbul", sharesTraded: true },
    attention: [],
    articles: [],
    articlesTruncated: false,
    disclosures: [],
    totalDisclosures30d: 0,
    coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
    ...page,
  });
  fetchQuoteStatsMock.mockResolvedValue({});
  fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });
  getQuotesMock.mockResolvedValue(quotes);
  return collectEls(await TickerPage({ params: Promise.resolve({ ticker }) }));
}

describe("the trading-halt line (h11-finance-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const haltAnchor = (els: El[]) => els.find((e) => e.type === "a" && e.props.href === HALT_LINK && String(e.props.className ?? "").includes("text-amber-400"));

  it("shows a closing notice newer than the last trade under the 'son işlem' line, as a KAP link", async () => {
    const els = await renderTicker("TRHOL", { disclosures: [haltNotice()] }, trholQuote("2026-10-27T15:00:00.000Z"));

    expect(els.some((e) => textOfNode(e.props.children).includes("son işlem 27.10.2026"))).toBe(true);
    const a = haltAnchor(els);
    expect(a).toBeDefined();
    expect(textOfNode(a!.props.children)).toBe("İşlem sırası kapatıldı · KAP 28.10 09:38");
    expect(a!.props.target).toBe("_blank");
    expect(a!.props.rel).toBe("noopener noreferrer");
    expect(String(a!.props.className)).toContain("text-[11px]");
    expect(String(a!.props.className)).toContain("text-amber-400");
  });

  it("shows it under the empty-price label when there is no quote", async () => {
    const els = await renderTicker("TRHOL", { disclosures: [haltNotice()] }, {});
    expect(els.some((e) => textOfNode(e.props.children) === "fiyat alınamadı")).toBe(true);
    expect(haltAnchor(els)).toBeDefined();
  });

  it("is not shown when the stock traded after the notice", async () => {
    const els = await renderTicker("TRHOL", { disclosures: [haltNotice()] }, trholQuote("2026-10-30T15:00:00.000Z"));
    expect(haltAnchor(els)).toBeUndefined();
  });

  it("is not shown when the newest halt notice is the reopening", async () => {
    const reopening = haltNotice({ disclosureIndex: 1688700, publishedAt: "2026-10-28T13:00:00Z", summary: "Pay Sırasının İşleme Açılması" });
    const els = await renderTicker("TRHOL", { disclosures: [reopening, haltNotice()] }, trholQuote("2026-10-27T15:00:00.000Z"));
    expect(els.some((e) => e.type === "a" && String(e.props.href).includes("1688666") && String(e.props.className ?? "").includes("text-amber-400"))).toBe(false);
  });

  it("is not shown when there is no halt notice at all", async () => {
    const els = await renderTicker("TRHOL", { disclosures: [] }, trholQuote("2026-10-27T15:00:00.000Z"));
    expect(els.some((e) => textOfNode(e.props.children).includes("İşlem sırası kapatıldı"))).toBe(false);
  });
});

describe("the limit tag on the header price is tick-aware (h11-finance-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const infoQuote = (prevClose: number, price: number) => ({
    INFO: {
      ticker: "INFO",
      price,
      prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      hasBaseline: true,
      closes: [prevClose, price],
      currency: "TRY",
      asOf: "2026-10-30T15:00:00.000Z",
    },
  });
  const tagText = (els: El[]) => els.filter((e) => e.type === "span" && String(e.props.className ?? "").includes("bg-brand/20")).map((e) => textOfNode(e.props.children));

  it("INFO 0.66 -> 0.60 (-9.09 %) is tagged taban", async () => {
    expect(tagText(await renderTicker("INFO", {}, infoQuote(0.66, 0.6)))).toEqual(["taban"]);
  });

  it("6.98 -> 6.30 (-9.74 %) is not tagged", async () => {
    expect(tagText(await renderTicker("INFO", {}, infoQuote(6.98, 6.3)))).toEqual([]);
  });
});

describe("honest window labels (h11-finance-3)", () => {
  const disclosures = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      disclosureIndex: 1000 + i,
      publishedAt: new Date(Date.parse("2026-10-30T10:00:00Z") - i * 3_600_000).toISOString(),
      kapTitle: "İŞ YATIRIM A.Ş.",
      stockCodes: ["ISMEN"],
      subject: "Özel Durum Açıklaması (Genel)",
      summary: null,
      disclosureClass: "ODA",
    }));

  it("a list cut at 60 says 'son 60 bildirim (30 günde 102)' in both panels", async () => {
    const els = await renderTicker("ISMEN", {
      disclosures: disclosures(60),
      totalDisclosures30d: 102,
      coverage: { disclosures: 60, events: 9, covered: 8, medianLagMinutes: 1932, pressAhead: 2 },
    });
    expect(panelMeta(els, "KAP ile basın arası")).toBe("son 60 bildirim (30 günde 102) · bildirimden sonraki 48 saat");
    expect(panelMeta(els, "KAP bildirimleri")).toBe("son 60 bildirim (30 günde 102)");
  });

  it("a short list keeps 'son 30 gün'", async () => {
    const els = await renderTicker("ISMEN", { disclosures: disclosures(12), totalDisclosures30d: 12 });
    expect(panelMeta(els, "KAP ile basın arası")).toBe("son 30 gün · bildirimden sonraki 48 saat");
    expect(panelMeta(els, "KAP bildirimleri")).toBe("son 30 gün");
  });

  it("a cut list whose count failed (null) still names the cap and no total", async () => {
    const els = await renderTicker("ISMEN", { disclosures: disclosures(60), totalDisclosures30d: null });
    expect(panelMeta(els, "KAP bildirimleri")).toBe("son 60 bildirim");
  });

  it("the coverage panel has an 'olay' cell, five columns and the event footnote", async () => {
    const els = await renderTicker("ISMEN", {
      disclosures: disclosures(60),
      totalDisclosures30d: 102,
      coverage: { disclosures: 60, events: 9, covered: 8, medianLagMinutes: 1932, pressAhead: 2 },
    });
    const dl = els.find((e) => e.type === "dl" && String(e.props.className ?? "").includes("sm:grid-cols-"));
    expect(String(dl?.props.className)).toContain("sm:grid-cols-5");
    const labels = collectEls(dl).filter((e) => e.type === "dt").map((e) => textOfNode(e.props.children));
    expect(labels).toEqual(["bildirim", "olay", "basında yer bulan", "ilk haber, medyan", "olağandışı ön ilgi"]);
    const values = collectEls(dl).filter((e) => e.type === "dd").map((e) => textOfNode(e.props.children));
    expect(values.slice(0, 3)).toEqual(["60", "9", "8"]);

    const footnote = els.find((e) => e.type === "p" && textOfNode(e.props.children).startsWith("Aynı 24 saat"));
    expect(textOfNode(footnote?.props.children)).toBe(
      "Aynı 24 saat içindeki bildirimler tek olay sayılır; bir haber her olayda bir kez sayılır. Basında yer bulan ve ilk haber, olaydaki ilk bildirimden sonraki 48 saat içinde çıkan haberlere göre ölçülür; daha geç haberler sayılmaz. Ön ilgi: olaydan önceki 24 saatte en az 2 haber ve hissenin olağan günlük haber sayısının en az 3 katı. Bu bölüm yalnızca şirketin kendi bildirimleri üzerinden hesaplanır.",
    );
  });

  it("the coverage footnote names the listed notices the section does not count (halts, bans, insider trades)", async () => {
    const els = await renderTicker("ISMEN", {
      disclosures: disclosures(60),
      totalDisclosures30d: 102,
      coverage: { disclosures: 55, events: 9, covered: 8, medianLagMinutes: 1932, pressAhead: 2 },
    });
    const footnote = els.find((e) => e.type === "p" && textOfNode(e.props.children).startsWith("Aynı 24 saat"));
    const text = textOfNode(footnote?.props.children);
    expect(text).toContain("Hisseyi yalnızca anan 5 bildirim");
    expect(text).toContain("sayılmaz");
  });

  it("the Haberler panel says 'son 60 haber' when ticker_articles was full and '13 haber' otherwise", async () => {
    const article = (i: number) => ({
      id: `a${i}`,
      title: `Haber ${i}`,
      url: `https://x/${i}`,
      publishedAt: "2026-10-30T10:00:00Z",
      category: "ekonomi",
      source: { name: "Dünya", slug: "dunya" },
      tickers: ["ISMEN"],
    });
    const full = await renderTicker("ISMEN", { articles: Array.from({ length: 60 }, (_, i) => article(i)), articlesTruncated: true });
    expect(panelMeta(full, "Haberler")).toBe("son 60 haber");
    const some = await renderTicker("ISMEN", { articles: Array.from({ length: 13 }, (_, i) => article(i)), articlesTruncated: false });
    expect(panelMeta(some, "Haberler")).toBe("13 haber");
  });
});

describe("the H1 names the company (hunt-17)", () => {
  const h1Of = (els: El[]) => els.find((e) => e.type === "h1");
  const company = (title: string, ticker: string) => ({
    kapMemberOid: "kap-1",
    tickers: [ticker],
    title,
    city: "İstanbul",
    sharesTraded: true,
  });

  it("reads 'Arçelik ARCLK' with the ticker in a mono span, and keeps the full legal title below", async () => {
    const els = await renderTicker("ARCLK", { company: company("ARÇELİK A.Ş.", "ARCLK") });

    const h1 = h1Of(els);
    expect(h1).toBeDefined();
    expect(textOfNode(h1)).toBe("Arçelik ARCLK");
    const tickerSpan = collectEls(h1).find(
      (e) => e.type === "span" && String(e.props.className ?? "").includes("font-mono"),
    );
    expect(tickerSpan).toBeDefined();
    expect(textOfNode(tickerSpan!.props.children)).toBe("ARCLK");
    expect(String(h1!.props.className)).toContain("text-3xl");

    // The legal name stays in the subtitle paragraph.
    const subtitle = els.find((e) => e.type === "p" && textOfNode(e.props.children) === "ARÇELİK A.Ş.");
    expect(subtitle).toBeDefined();
  });

  it("falls back to the old ticker-only H1 when the company title yields no name", async () => {
    const els = await renderTicker("KTEST", { company: company("X A.Ş.", "KTEST") });
    const h1 = h1Of(els);
    expect(textOfNode(h1)).toBe("KTEST");
    expect(String(h1!.props.className)).toContain("font-mono");
    expect(String(h1!.props.className)).toContain("text-brand");
  });

  it("is exactly the ticker (the old markup) when there is no company row", async () => {
    const els = await renderTicker("ZZZZZZ", { company: null });
    const h1 = h1Of(els);
    expect(textOfNode(h1)).toBe("ZZZZZZ");
    expect(String(h1!.props.className)).toContain("font-mono");
    expect(String(h1!.props.className)).toContain("text-brand");
    expect(els.some((e) => e.type === "p" && textOfNode(e.props.children) === "Şirket kaydı bulunamadı")).toBe(true);
  });

  it("keeps the breadcrumb on the bare ticker", async () => {
    const els = await renderTicker("ARCLK", { company: company("ARÇELİK A.Ş.", "ARCLK") });
    const nav = els.find((e) => e.type === "nav");
    expect(textOfNode(nav!.props.children)).toBe("Ekonomi/ARCLK");
  });
});

// ---------------------------------------------------------------------------
// h41-resilience-3: the quote stats and the intraday bars are decorative. Their
// failure must not replace the whole ticker page with the error boundary; the
// page that depends on the ticker's own data (existence probe, fetchTickerPage)
// still throws exactly as before.
// ---------------------------------------------------------------------------

import { IntradayChart } from "@/components/finance/intraday-chart";
import { PanelEmpty } from "@/components/finance/panel";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { fmtPct, fmtPrice } from "@/lib/finance/format";

describe("optional reads degrade instead of throwing (h41-resilience-3)", () => {
  const CHART_NOTE = "Gün içi grafik şu an yüklenemedi.";
  const NO_DATA_COPY = "Bu hisse için seans içi veri henüz toplanmadı. Haberde geçen hisseler seans boyunca 5 dakikada bir kaydedilir.";
  const params = () => Promise.resolve({ ticker: "THYAO" });

  // Yahoo's payload during the session: the previous close is two sessions back
  // (300), so a 330 price reads as +10 % / tavan. 2026-11-05 is a Thursday and
  // 11:50Z is inside the BIST session, so the quote is live, not halted.
  const yahoo = () => ({
    THYAO: {
      ticker: "THYAO",
      price: 330,
      prevClose: 300,
      changePct: 10,
      hasBaseline: true,
      closes: [290, 300, 330],
      currency: "TRY",
      asOf: "2026-11-05T11:50:00.000Z",
    },
  });

  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    stubRenderableTickerPage();
    getQuotesMock.mockResolvedValue(yahoo());
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const render = async () => collectEls(await TickerPage({ params: params() }));
  const emptyNotes = (els: El[]) => els.filter((e) => e.type === PanelEmpty).map((e) => textOfNode(e.props.children));
  const limitTags = (els: El[]) =>
    els.filter((e) => e.type === "span" && String(e.props.className ?? "").includes("bg-brand/20")).map((e) => textOfNode(e.props.children));
  const unknownMove = (els: El[]) => els.some((e) => e.type === "span" && textOfNode(e.props.children) === "değişim bilinmiyor");

  describe("fetchIntraday rejects", () => {
    it("the page resolves, the chart slot is empty and says the chart could not be loaded", async () => {
      fetchIntradayMock.mockRejectedValue(new Error("[finance] fetchIntraday: statement timeout"));

      const els = await render();

      expect(els.some((e) => e.type === IntradayChart)).toBe(false);
      expect(emptyNotes(els)).toContain(CHART_NOTE);
      expect(emptyNotes(els)).not.toContain(NO_DATA_COPY);
      // The header must not claim the data is absent when the read merely failed.
      const panel = els.find((e) => e.props.title === "Seans içi");
      expect(panel?.props.meta).toBe("5 dakikalık veri yüklenemedi");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: intraday");
    });

    it("the rest of the page still renders (header, price, panels)", async () => {
      fetchIntradayMock.mockRejectedValue(new Error("boom"));

      const els = await render();

      expect(els.find((e) => e.type === "h1")).toBeDefined();
      expect(els.some((e) => e.props.title === "Basın ilgisi")).toBe(true);
      expect(els.some((e) => e.props.title === "KAP bildirimleri")).toBe(true);
    });

    it("a read that SUCCEEDED with no bars keeps the old empty copy (the note is only for a failure)", async () => {
      fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });

      const els = await render();
      const notes = emptyNotes(els);

      expect(notes).toContain(NO_DATA_COPY);
      expect(notes).not.toContain(CHART_NOTE);
      // An answered read with no data keeps the original absence claim.
      expect(els.find((e) => e.props.title === "Seans içi")?.props.meta).toBe("5 dakikalık veri henüz yok");
      expect(warn).not.toHaveBeenCalled();
    });

    it("a read that succeeded with bars still draws the chart, unchanged", async () => {
      const bars = [
        { ts: "2026-11-05T07:00:00.000Z", close: 321, volume: 10 },
        { ts: "2026-11-05T07:05:00.000Z", close: 322, volume: 12 },
      ];
      fetchIntradayMock.mockResolvedValue({ day: "2026-11-05", bars });

      const els = await render();

      const chart = els.find((e) => e.type === IntradayChart);
      expect(chart?.props.bars).toEqual(bars);
      expect(emptyNotes(els)).not.toContain(CHART_NOTE);
    });
  });

  describe("fetchQuoteStats rejects", () => {
    it("the page resolves with a known-move-free quote: the move is '—' and there is no tavan/taban tag", async () => {
      fetchQuoteStatsMock.mockRejectedValue(new Error("[finance] fetchQuoteStats: statement timeout"));

      const els = await render();

      expect(limitTags(els)).toEqual([]);
      expect(unknownMove(els)).toBe(true);
      // Yahoo's +10 % (two sessions back) is not printed anywhere.
      expect(JSON.stringify(els.map((e) => textOfNode(e.props.children)))).not.toContain(fmtPct(10));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: quote-stats");
    });

    it("still shows Yahoo's price", async () => {
      fetchQuoteStatsMock.mockRejectedValue(new Error("boom"));

      const els = await render();

      expect(els.some((e) => e.type === "span" && String(e.props.className ?? "").includes("text-3xl") && textOfNode(e.props.children) === fmtPrice(330))).toBe(true);
    });

    it("control: with the stats read answering (even empty) the same Yahoo quote IS tagged tavan", async () => {
      fetchQuoteStatsMock.mockResolvedValue({});

      const els = await render();

      expect(limitTags(els)).toEqual(["tavan"]);
      expect(unknownMove(els)).toBe(false);
      // The +10 % IS printed here, so the absence check above is not vacuous.
      expect(JSON.stringify(els.map((e) => textOfNode(e.props.children)))).toContain(fmtPct(10));
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not stop the intraday chart from drawing", async () => {
      fetchQuoteStatsMock.mockRejectedValue(new Error("boom"));
      fetchIntradayMock.mockResolvedValue({
        day: "2026-11-05",
        bars: [
          { ts: "2026-11-05T07:00:00.000Z", close: 321, volume: 10 },
          { ts: "2026-11-05T07:05:00.000Z", close: 322, volume: 12 },
        ],
      });

      const els = await render();

      const chart = els.find((e) => e.type === IntradayChart);
      expect(chart).toBeDefined();
      // No stat and no baseline on the quote: the dashed previous-close line is dropped, not guessed.
      expect(chart!.props.prevClose).toBeNull();
    });
  });

  describe("both decorative reads reject", () => {
    it("the page still resolves, with one warning per read", async () => {
      fetchQuoteStatsMock.mockRejectedValue(new Error("a"));
      fetchIntradayMock.mockRejectedValue(new Error("b"));

      const els = await render();

      expect(limitTags(els)).toEqual([]);
      expect(emptyNotes(els)).toContain(CHART_NOTE);
      expect(warn.mock.calls.map((c) => c[0]).sort()).toEqual([
        "[ekonomi] optional read failed: intraday",
        "[ekonomi] optional read failed: quote-stats",
      ]);
    });
  });

  describe("the essential reads keep their throw contract", () => {
    it("fetchTickerPage rejecting rejects the page", async () => {
      const boom = new Error("[finance] fetchTickerPage: statement timeout");
      fetchTickerPageMock.mockRejectedValue(boom);

      await expect(TickerPage({ params: params() })).rejects.toBe(boom);
      expect(warn).not.toHaveBeenCalled();
    });

    it("an unknown existence probe still rejects the page", async () => {
      probeState.company = { data: null, error: TIMEOUT };

      await expect(TickerPage({ params: params() })).rejects.toThrow("[ekonomi] ticker existence unknown: THYAO");
    });
  });
});

// ---------------------------------------------------------------------------
// h92-marketclock-1: bist_intraday_targets used a rolling 7-day news window, so a
// ticker could leave the target list mid-session and its 5-minute bars stopped
// there. VKING 2026-11-06: bars to 12:05 Istanbul (09:05Z), the last at 11,53; the
// daily close 12,09 and the header 12,09. The chart's last price, colour and
// aria-label contradicted the header. When the session is over, the bars end before
// 17:30 and the last bar is more than 0.5 % off the settled close, the page hands
// the settled close to the chart and says in the panel meta where the data stops.
// ---------------------------------------------------------------------------

describe("a session whose 5-minute bars were cut short (h92-marketclock-1)", () => {
  const params = () => Promise.resolve({ ticker: "VKING" });
  const CUT_META = "06.11.2026, 5 dakikalık kapanışlar, 12:05 sonrası veri eksik, haberler işaretli";
  const PLAIN_META = "06.11.2026, 5 dakikalık kapanışlar, haberler işaretli";

  const vkingQuote = () => ({
    VKING: {
      ticker: "VKING",
      price: 12.09,
      prevClose: 11.67,
      changePct: 3.6,
      hasBaseline: true,
      closes: [11.4, 11.52, 11.67, 12.09],
      currency: "TRY",
      asOf: "2026-11-06T15:00:00.000Z",
    },
  });
  const vkingStat = (over: Record<string, unknown> = {}) => ({
    VKING: {
      ticker: "VKING",
      lastDay: "2026-11-06",
      lastClose: 12.09,
      prevClose: 11.67,
      lastVolume: 307202,
      avgVolume20: 250000,
      rvol: 1.2,
      ...over,
    },
  });
  const cutBars = () => [
    { ts: "2026-11-06T06:55:00.000Z", close: 11.7, volume: 90 },
    { ts: "2026-11-06T08:00:00.000Z", close: 11.62, volume: 40 },
    { ts: "2026-11-06T09:05:00.000Z", close: 11.53, volume: 0 },
  ];
  const fullBars = () => [
    { ts: "2026-11-06T06:55:00.000Z", close: 11.7, volume: 90 },
    { ts: "2026-11-06T11:00:00.000Z", close: 11.9, volume: 40 },
    { ts: "2026-11-06T14:55:00.000Z", close: 12.09, volume: 700 },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    // Monday 05:30 Istanbul: the 06.11 session is long over.
    vi.setSystemTime(new Date("2026-11-09T02:30:00Z"));
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    stubRenderableTickerPage();
    getQuotesMock.mockResolvedValue(vkingQuote());
    fetchQuoteStatsMock.mockResolvedValue(vkingStat());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const render = async () => collectEls(await TickerPage({ params: params() }));
  const chartOf = (els: El[]) => els.find((e) => e.type === IntradayChart);

  it("VKING: the chart gets the settled close 12,09 and the panel meta says the data stops after 12:05", async () => {
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: cutBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBe(12.09);
    expect(panelMeta(els, "Seans içi")).toBe(CUT_META);
    // the chart still draws the bars it has and the baseline stays the stat's previous close
    expect(chartOf(els)?.props.bars).toEqual(cutBars());
    expect(chartOf(els)?.props.prevClose).toBe(11.67);
  });

  it("a full session (last bar is the 17:55 closing auction): no override and today's meta", async () => {
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: fullBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBeNull();
    expect(panelMeta(els, "Seans içi")).toBe(PLAIN_META);
  });

  it("the same bars while the session is still open (Friday 13:00 Istanbul): no override", async () => {
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: cutBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBeNull();
    expect(panelMeta(els, "Seans içi")).toBe(PLAIN_META);
  });

  it("no stat for the ticker: nothing to settle against, no override", async () => {
    fetchQuoteStatsMock.mockResolvedValue({});
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: cutBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBeNull();
    expect(panelMeta(els, "Seans içi")).toBe(PLAIN_META);
  });

  it("a stat read that failed: no override (the header has no settled close either)", async () => {
    fetchQuoteStatsMock.mockRejectedValue(new Error("[finance] fetchQuoteStats: statement timeout"));
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: cutBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBeNull();
    expect(panelMeta(els, "Seans içi")).toBe(PLAIN_META);
  });

  it("a stat of another day (the daily bar is newer than the bars): no override", async () => {
    fetchQuoteStatsMock.mockResolvedValue(vkingStat({ lastDay: "2026-11-09" }));
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: cutBars() });

    const els = await render();

    expect(chartOf(els)?.props.closeOverride).toBeNull();
    expect(panelMeta(els, "Seans içi")).toBe(PLAIN_META);
  });

  it("no bars at all: no chart, the old empty-state meta, and the guard never throws", async () => {
    fetchIntradayMock.mockResolvedValue({ day: null, bars: [] });

    const els = await render();

    expect(chartOf(els)).toBeUndefined();
    expect(panelMeta(els, "Seans içi")).toBe("5 dakikalık veri henüz yok");
  });
});

// ---------------------------------------------------------------------------
// h99-financenumbers-1: during a live session bist_quote_stats still holds the
// previous session (the daily bar lands about 19:33 Istanbul). A ticker with no
// 5-minute bars has no intraday day to compare the volume's day with, so the
// header read Friday's relative volume with no day next to today's quote
// (ACSEL "92,70 +%1,87 bugun hacim 20 gunluk ortalamanin 3,0 kati"). The page
// falls back to the quote's own session day.
// ---------------------------------------------------------------------------

describe("the header volume line of a ticker with no 5-minute bars (h99-financenumbers-1)", () => {
  const params = () => Promise.resolve({ ticker: "ACSEL" });
  const acselQuote = (asOf: string) => ({
    ACSEL: { ticker: "ACSEL", price: 92.7, prevClose: 91, changePct: 1.87, hasBaseline: true, closes: [94.05, 91, 92.7], currency: "TRY", asOf },
  });
  const acselStat = (lastDay: string) => ({
    ACSEL: { ticker: "ACSEL", lastDay, lastClose: 91, prevClose: 94.05, lastVolume: 1, avgVolume20: 1, rvol: 3.03 },
  });
  const volumeTitle = (els: El[]) =>
    els.map((e) => e.props.title).find((t): t is string => typeof t === "string" && t.startsWith("hacim "));

  beforeEach(() => {
    vi.useFakeTimers();
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    stubRenderableTickerPage();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const render = async () => collectEls(await TickerPage({ params: params() }));

  it("Monday 10:28 Istanbul: today's quote beside Friday's volume names the day: '... · 06.11 seansı'", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T07:20:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));

    const els = await render();

    expect(volumeTitle(els)).toBe("hacim 20 günlük ortalamanın 3,0 katı · 06.11 seansı");
  });

  it("after the daily bar lands (the stat is today's) there is no day suffix", async () => {
    vi.setSystemTime(new Date("2026-11-09T16:40:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T15:00:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-09"));

    expect(volumeTitle(await render())).toBe("hacim 20 günlük ortalamanın 3,0 katı");
  });

  it("on the weekend the quote and the stat are the same Friday: no day suffix", async () => {
    vi.setSystemTime(new Date("2026-11-08T09:32:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-06T15:00:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));

    expect(volumeTitle(await render())).toBe("hacim 20 günlük ortalamanın 3,0 katı");
  });

  it("a ticker WITH 5-minute bars still takes the bars' day (unchanged)", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T07:20:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));
    fetchIntradayMock.mockResolvedValue({
      day: "2026-11-09",
      bars: [
        { ts: "2026-11-09T07:00:00.000Z", close: 92.5, volume: 10 },
        { ts: "2026-11-09T07:05:00.000Z", close: 92.7, volume: 12 },
      ],
    });

    expect(volumeTitle(await render())).toBe("hacim 20 günlük ortalamanın 3,0 katı · 06.11 seansı");
  });

  it("a halted quote (last trade days old) shows no volume at all", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-10-27T15:00:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-10-27"));

    expect(volumeTitle(await render())).toBeUndefined();
  });

  it("no quote: the volume is shown for neither (no header block), and nothing throws", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue({});
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));

    expect(volumeTitle(await render())).toBeUndefined();
  });

  // The amber flag means "today's volume is unusual". It follows TickerTape: a
  // volume read from another session (it carries a day label) is not today's
  // signal, so the header keeps it muted (rvol 3.03 would otherwise be amber).
  const volumeEl = (els: El[]) => els.find((e) => typeof e.props.title === "string" && e.props.title.startsWith("hacim "));

  it("Monday 10:28 Istanbul: Friday's volume (it carries a day label) is not amber", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T07:20:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));

    const el = volumeEl(await render());

    expect(el).toBeDefined();
    expect(String(el!.props.className)).not.toContain("text-amber-400");
    expect(String(el!.props.className)).toContain("text-muted-foreground");
  });

  it("after the daily bar lands (the stat is today's) an rvol of 2 or more stays amber", async () => {
    vi.setSystemTime(new Date("2026-11-09T16:40:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T15:00:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-09"));

    const el = volumeEl(await render());

    expect(el).toBeDefined();
    expect(String(el!.props.className)).toContain("text-amber-400");
  });

  it("a ticker WITH 5-minute bars but a stat from the previous session is not amber either", async () => {
    vi.setSystemTime(new Date("2026-11-09T07:28:00Z"));
    getQuotesMock.mockResolvedValue(acselQuote("2026-11-09T07:20:00Z"));
    fetchQuoteStatsMock.mockResolvedValue(acselStat("2026-11-06"));
    fetchIntradayMock.mockResolvedValue({
      day: "2026-11-09",
      bars: [
        { ts: "2026-11-09T07:00:00.000Z", close: 92.5, volume: 10 },
        { ts: "2026-11-09T07:05:00.000Z", close: 92.7, volume: 12 },
      ],
    });

    const el = volumeEl(await render());

    expect(el).toBeDefined();
    expect(String(el!.props.className)).not.toContain("text-amber-400");
  });
});

// ---------------------------------------------------------------------------
// h101-a11yrecent-2 (WCAG 3.1.2 Language of Parts): /ekonomi/<ticker> is lang="tr", and its "Haberler" list and the
// intraday chart's marker captions print headlines verbatim. An English outlet's headline (ASELS: Daily Sabah,
// Hürriyet Daily News) must carry lang="en" on the headline text, on the source-name cell and on its chart marker;
// a Turkish outlet's row and the Turkish "KAP: ..." marker render no attribute. The headline lang sits on an inner
// span, not on the anchor, because the anchor also holds <NewTabHint />, a Turkish sr-only cue that must not
// inherit "en". The page is a server component, so these read the element tree (the chart's own caption markup is
// pinned in intraday-chart.test.ts).
// ---------------------------------------------------------------------------
describe("news rows and chart markers carry the source's language (h101-a11yrecent-2)", () => {
  const EN_TITLE = "Türkiye's defense giant Aselsan turns to solar to meet all energy needs";
  const EN_TITLE_2 = "Aselsan signs $1.1 billion air defense export deal";
  const TR_TITLE = "Aselsan yeni ihracat sözleşmesi imzaladı";
  const OLD_EN_TITLE = "Aselsan earnings preview from the day before";
  const SABAH = { name: "Daily Sabah", slug: "daily-sabah" };
  const HDN = { name: "Hürriyet Daily News", slug: "hurriyet-daily-news" };
  const SOZCU = { name: "Sözcü", slug: "sozcu" };

  const article = (id: string, source: { name: string; slug: string } | null, title: string, publishedAt: string) => ({
    id,
    title,
    url: `https://example.com/${id}`,
    publishedAt,
    category: "ekonomi",
    source,
    tickers: ["ASELS"],
  });
  // 08:00Z, 08:10Z, 08:20Z are 11:00, 11:10, 11:20 in Istanbul on 2026-11-06, the session the bars are from.
  const ARTICLES = [
    article("en1", SABAH, EN_TITLE, "2026-11-06T08:00:00.000Z"),
    article("en2", HDN, EN_TITLE_2, "2026-11-06T08:10:00.000Z"),
    article("tr1", SOZCU, TR_TITLE, "2026-11-06T08:20:00.000Z"),
    article("old", SABAH, OLD_EN_TITLE, "2026-11-05T08:00:00.000Z"),
  ];
  const KAP_DISCLOSURE = {
    disclosureIndex: 1700001,
    publishedAt: "2026-11-06T08:30:00.000Z",
    kapTitle: "ASELSAN ELEKTRONİK SANAYİ VE TİCARET A.Ş.",
    stockCodes: ["ASELS"],
    subject: "Yeni İş İlişkisi",
    summary: null,
    disclosureClass: null,
  };
  const BARS = [
    { ts: "2026-11-06T06:55:00.000Z", close: 92.5, volume: 90 },
    { ts: "2026-11-06T11:00:00.000Z", close: 92.9, volume: 40 },
    { ts: "2026-11-06T14:55:00.000Z", close: 93.4, volume: 700 },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T02:30:00Z"));
    probeState.company = { data: [{ kap_member_oid: "kap-1", shares_traded: true }], error: null };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderAsels(articles: unknown[], disclosures: unknown[] = []) {
    fetchTickerPageMock.mockResolvedValue({
      company: null,
      attention: [],
      articles,
      articlesTruncated: false,
      disclosures,
      totalDisclosures30d: disclosures.length,
      coverage: { disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
    });
    fetchQuoteStatsMock.mockResolvedValue({});
    fetchIntradayMock.mockResolvedValue({ day: "2026-11-06", bars: BARS });
    getQuotesMock.mockResolvedValue({});
    return collectEls(await TickerPage({ params: Promise.resolve({ ticker: "ASELS" }) }));
  }

  const anchorFor = (els: El[], id: string) => els.find((e) => e.type === "a" && e.props.href === `https://example.com/${id}`);
  /** The anchor's direct children as an array (React leaves a single child unwrapped). */
  const kidsOf = (a: El) => ([] as unknown[]).concat(a.props.children ?? []) as El[];
  /** The anchor's child span that prints the headline. */
  const titleSpanOf = (a: El, title: string) =>
    kidsOf(a).find((k) => k.type === "span" && textOfNode(k.props.children) === title);
  /** The anchor's direct <NewTabHint /> children. */
  const hintsOf = (a: El) => kidsOf(a).filter((k) => k.type === NewTabHint);
  /** The source-name cell of the news list (the sm:block span), found by its text. */
  const nameCell = (els: El[], name: string) =>
    els.find((e) => e.type === "span" && String(e.props.className ?? "").includes("sm:block") && textOfNode(e.props.children) === name);
  type Marker = { ts: string; label: string; lang?: string };
  const markersOf = (els: El[]) => els.find((e) => e.type === IntradayChart)!.props.markers as Marker[];
  const markerFor = (els: El[], label: string) => markersOf(els).find((m) => m.label === label);

  it("Daily Sabah and Hürriyet Daily News rows: the headline text span and the source-name cell are lang=\"en\", the anchor is not", async () => {
    const els = await renderAsels(ARTICLES);

    for (const [id, title] of [["en1", EN_TITLE], ["en2", EN_TITLE_2]] as const) {
      const a = anchorFor(els, id)!;
      expect(a.props.lang).toBeUndefined();
      const span = titleSpanOf(a, title);
      expect(span, id).toBeDefined();
      expect(span!.props.lang).toBe("en");
      // The Turkish new-tab cue is a direct child of the anchor, outside the English span.
      expect(span!.props.children).toBe(title);
      expect(hintsOf(a)).toHaveLength(1);
    }
    expect(nameCell(els, "Daily Sabah")!.props.lang).toBe("en");
    expect(nameCell(els, "Hürriyet Daily News")!.props.lang).toBe("en");
  });

  it("a Sözcü row renders no lang on its link, its title span or its source-name cell", async () => {
    const els = await renderAsels(ARTICLES);

    const a = anchorFor(els, "tr1")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, TR_TITLE)!.props.lang).toBeUndefined();
    expect(hintsOf(a)).toHaveLength(1);
    expect(nameCell(els, "Sözcü")!.props.lang).toBeUndefined();
  });

  it("a row with no source renders, with no lang on its link or its title span", async () => {
    const els = await renderAsels([article("ns", null, TR_TITLE, "2026-11-06T08:00:00.000Z")]);

    const a = anchorFor(els, "ns")!;
    expect(a.props.lang).toBeUndefined();
    expect(titleSpanOf(a, TR_TITLE)!.props.lang).toBeUndefined();
    expect(hintsOf(a)).toHaveLength(1);
  });

  it("the chart markers of English articles carry lang 'en'; Turkish articles and KAP disclosures carry none", async () => {
    const els = await renderAsels(ARTICLES, [KAP_DISCLOSURE]);

    expect(markerFor(els, EN_TITLE)!.lang).toBe("en");
    expect(markerFor(els, EN_TITLE_2)!.lang).toBe("en");
    expect(markerFor(els, TR_TITLE)!.lang).toBeUndefined();
    const kap = markerFor(els, "KAP: Yeni İş İlişkisi");
    expect(kap).toBeDefined();
    expect(kap!.lang).toBeUndefined();
  });

  it("an article from another day is in the list (marked) but not on the chart", async () => {
    const els = await renderAsels(ARTICLES);

    expect(anchorFor(els, "old")!.props.lang).toBeUndefined();
    expect(titleSpanOf(anchorFor(els, "old")!, OLD_EN_TITLE)!.props.lang).toBe("en");
    expect(markerFor(els, OLD_EN_TITLE)).toBeUndefined();
  });

  it("the markers stay in time order and keep their ts and label, whatever the language", async () => {
    const els = await renderAsels(ARTICLES, [KAP_DISCLOSURE]);

    expect(markersOf(els).map((m) => [m.ts, m.label])).toEqual([
      ["2026-11-06T08:00:00.000Z", EN_TITLE],
      ["2026-11-06T08:10:00.000Z", EN_TITLE_2],
      ["2026-11-06T08:20:00.000Z", TR_TITLE],
      ["2026-11-06T08:30:00.000Z", "KAP: Yeni İş İlişkisi"],
    ]);
  });
});
