import { describe, it, expect, vi, beforeEach } from "vitest";

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
    company: { data: [] as unknown[], error: null as { message: string } | null },
    articles: { data: [] as unknown[], error: null as { message: string } | null },
    disclosures: { data: [] as unknown[], error: null as { message: string } | null },
  },
}));
companyProbeMock.mockImplementation(async () => probeState.company);
articlesProbeMock.mockImplementation(async () => probeState.articles);
disclosuresProbeMock.mockImplementation(async () => probeState.disclosures);

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
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
    fetchTickerPage: (...args: unknown[]) => fetchTickerPageMock(...args),
    fetchQuoteStats: (...args: unknown[]) => fetchQuoteStatsMock(...args),
    fetchIntraday: (...args: unknown[]) => fetchIntradayMock(...args),
  };
});

vi.mock("@/lib/finance/quotes", () => ({
  getQuotes: (...args: unknown[]) => getQuotesMock(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    from: (table: string) => {
      if (table === "bist_companies") {
        return {
          select: (_cols: string) => ({
            contains: (_col: string, _val: unknown[]) => ({ limit: companyProbeMock }),
          }),
        };
      }
      if (table === "article_tickers") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, _val: unknown) => ({ limit: articlesProbeMock }),
          }),
        };
      }
      // kap_disclosures
      return {
        select: (_cols: string) => ({
          contains: (_col: string, _val: unknown[]) => ({ limit: disclosuresProbeMock }),
        }),
      };
    },
  }),
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
      disclosures: [],
      coverage: { disclosures: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
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
      disclosures: [],
      coverage: { disclosures: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
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
      disclosures: [],
      coverage: { disclosures: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
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
    probeState.company = { data: [{ kap_member_oid: "kap-1" }], error: null };
    const metadata = await generateMetadata({ params: Promise.resolve({ ticker: "asels" }) });
    expect(metadata.title).toBe("ASELS — hisse haberleri ve KAP bildirimleri");
  });
});
