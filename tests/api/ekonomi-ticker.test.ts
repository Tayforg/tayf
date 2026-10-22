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
    disclosures: [],
    coverage: { disclosures: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 },
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
    expect(metadata.alternates).toBeUndefined();
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
