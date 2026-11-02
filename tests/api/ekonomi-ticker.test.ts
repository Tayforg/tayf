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
    expect(panelMeta(els, "KAP ile basın arası")).toBe("son 60 bildirim (30 günde 102)");
    expect(panelMeta(els, "KAP bildirimleri")).toBe("son 60 bildirim (30 günde 102)");
  });

  it("a short list keeps 'son 30 gün'", async () => {
    const els = await renderTicker("ISMEN", { disclosures: disclosures(12), totalDisclosures30d: 12 });
    expect(panelMeta(els, "KAP ile basın arası")).toBe("son 30 gün");
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
      "Aynı 24 saat içindeki bildirimler tek olay sayılır; bir haber her olayda bir kez sayılır. İlk haber, olaydaki ilk bildirimden sonra çıkan ilk habere göre ölçülür. Ön ilgi: olaydan önceki 24 saatte en az 2 haber ve hissenin olağan günlük haber sayısının en az 3 katı. Bu bölüm yalnızca şirketin kendi bildirimleri üzerinden hesaplanır.",
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
