import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// kap-media-pickup — IO layer tests. Uses the shared chainable Supabase
// fake (tests/_helpers/supabase-fake.ts) directly against fetchTickerPickup
// (no createServerClient/createFinanceServerClient indirection needed
// there), and mocks next/cache + @/lib/supabase/server separately for the
// "use cache" getTickerPickup(Safe) wrappers.
// ---------------------------------------------------------------------------

const cacheMocks = vi.hoisted(() => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

vi.mock("next/cache", () => ({
  cacheLife: cacheMocks.cacheLife,
  cacheTag: cacheMocks.cacheTag,
}));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-28T12:00:00.000Z").getTime();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// Order independence (vitest --sequence.shuffle): `vi.doMock` registrations
// survive `vi.resetModules()`, so the getTickerPickupSafe test's mocks of
// @/lib/supabase/server (a client whose .from is not a function) and of the
// module under test used to leak into whichever describe ran next. Every test
// therefore starts on a fresh module graph and leaves no doMock, fake timer or
// spy behind. The hoisted `vi.mock("next/cache")` above is unaffected by both.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/finance/kap-pickup-query");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchTickerPickup", () => {
  it("no disclosures -> an empty legitimate result with no article_tickers query", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    let articleTickersCalled = false;
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({ data: [], error: null }),
        article_tickers: () => {
          articleTickersCalled = true;
          return { data: [], error: null };
        },
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(result.pickups).toEqual([]);
    expect(result.totals.disclosures).toBe(0);
    expect(articleTickersCalled).toBe(false);
  });

  it("records contains(stock_codes,[T]), the Devre Kesici or() filter, and the mention gte = earliest disclosure - 3h", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const captured: { disclosures?: unknown; mentions?: unknown } = {};

    const disclosedAt1 = NOW - 20 * DAY;
    const disclosedAt2 = NOW - 10 * DAY;

    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: (state) => {
          captured.disclosures = state;
          return {
            data: [
              { disclosure_index: 2, published_at: iso(disclosedAt2), subject: null, disclosure_class: "ODA" },
              { disclosure_index: 1, published_at: iso(disclosedAt1), subject: "Bildirim", disclosure_class: "ODA" },
            ],
            error: null,
          };
        },
        article_tickers: (state) => {
          captured.mentions = state;
          return { data: [], error: null };
        },
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    const dState = captured.disclosures as {
      contains: Array<{ col: string; val: unknown }>;
      or: string[];
      eq: Array<{ col: string; val: unknown }>;
    };
    expect(dState.contains).toEqual([{ col: "stock_codes", val: ["THYAO"] }]);
    expect(dState.or.some((f) => f.includes("Devre Kesici"))).toBe(true);

    const mState = captured.mentions as {
      eq: Array<{ col: string; val: unknown }>;
      gte: Array<{ col: string; val: unknown }>;
    };
    expect(mState.eq).toEqual([{ col: "ticker", val: "THYAO" }]);
    const gte = mState.gte.find((g) => g.col === "published_at");
    expect(gte?.val).toBe(iso(disclosedAt1 - 3 * HOUR));
  });

  it("250 mentions triggers 3 relevance `in` calls of at most 100 keys", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const mentionRows = Array.from({ length: 250 }, (_, i) => ({
      article_id: `a${i}`,
      published_at: iso(NOW - HOUR),
      created_at: iso(NOW - HOUR),
      source_id: null,
    }));
    const relevanceInCalls: number[][] = [];

    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({ data: mentionRows, error: null }),
        jev_shadow_predictions: (state) => {
          const inArg = state.in.find((x) => x.col === "subject_id");
          relevanceInCalls.push((inArg?.vals as string[]) ?? []);
          return { data: [], error: null };
        },
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(relevanceInCalls.length).toBe(3);
    for (const call of relevanceInCalls) expect(call.length).toBeLessThanOrEqual(100);
    expect(relevanceInCalls.reduce((s, c) => s + c.length, 0)).toBe(250);
  });

  it("a relevance error fails open: relevanceApplied false, no throw, all mentions kept", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({
          data: [{ article_id: "a1", published_at: iso(NOW - DAY), created_at: iso(NOW - DAY), source_id: null }],
          error: null,
        }),
        jev_shadow_predictions: () => ({ data: null, error: { message: "boom" } }),
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(result.relevanceApplied).toBe(false);
    expect(result.pickups[0]!.articles).toBe(1);
  });

  it("a disclosure query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow();
  });

  it("a mention query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow();
  });

  it("a source query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({
          data: [{ article_id: "a1", published_at: iso(NOW - DAY), created_at: iso(NOW - DAY), source_id: "s1" }],
          error: null,
        }),
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow();
  });

  it("sets truncated=true when exactly MENTION_LIMIT (5000) mentions come back", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const mentionRows = Array.from({ length: 5000 }, (_, i) => ({
      article_id: `a${i}`,
      published_at: iso(NOW - HOUR),
      created_at: iso(NOW - HOUR),
      source_id: null,
    }));

    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({ data: mentionRows, error: null }),
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience for the page-facing wrappers: the panel is user-facing
// (/ekonomi/[ticker]), so the read runs under the 4 s reader cap, the "use
// cache" body never throws (attemptCached), and a failed attempt is memoised
// for "minutes" only. `getTickerPickup` still THROWS on failure (its callers
// decide), `getTickerPickupSafe` never does.
// ---------------------------------------------------------------------------

const TIMEOUT_ERROR = {
  message: "AbortError: Supabase request exceeded 4000 ms",
  hint: "Request was aborted (timeout or manual cancellation)",
  code: "",
};

describe("getTickerPickup / getTickerPickupSafe (cached attempt)", () => {
  const financeClient = vi.fn();

  async function loadWithClient(tables: Record<string, () => { data: unknown; error: unknown }>) {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({ tables: tables as never });
    financeClient.mockReset();
    financeClient.mockImplementation(async () => client);
    vi.doMock("@/lib/supabase/server", () => ({
      READER_TIMEOUT_MS: 4000,
      createFinanceServerClient: (opts?: unknown) => financeClient(opts),
    }));
    return import("@/lib/finance/kap-pickup-query");
  }

  beforeEach(() => {
    financeClient.mockReset();
    cacheMocks.cacheLife.mockClear();
    cacheMocks.cacheTag.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("builds the finance client with the 4 s reader timeout", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: [], error: null }),
    });
    await getTickerPickup("THYAO");
    expect(financeClient).toHaveBeenCalledTimes(1);
    expect(financeClient).toHaveBeenCalledWith({ timeoutMs: 4000 });
  });

  it("success calls cacheLife exactly once with the normal 5-minute profile and tags the ticker", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: [], error: null }),
    });
    const result = await getTickerPickup("THYAO");
    expect(result.ticker).toBe("THYAO");
    expect(result.pickups).toEqual([]);
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith({ stale: 60, revalidate: 300, expire: 3600 });
    expect(cacheMocks.cacheTag).toHaveBeenCalledWith("finance-feed", "finance-ticker:THYAO");
  });

  it("a timeout calls cacheLife exactly once with minutes, and getTickerPickup rejects", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: null, error: TIMEOUT_ERROR }),
    });
    await expect(getTickerPickup("THYAO")).rejects.toThrow(/AbortError: Supabase request exceeded 4000 ms/);
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("getTickerPickupSafe returns null on a timeout instead of throwing, still cached for minutes", async () => {
    const { getTickerPickupSafe } = await loadWithClient({
      kap_disclosures: () => ({ data: null, error: TIMEOUT_ERROR }),
    });
    await expect(getTickerPickupSafe("THYAO")).resolves.toBeNull();
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a client-construction failure is contained in the cached attempt: minutes, and Safe returns null", async () => {
    const { getTickerPickupSafe } = await loadWithClient({});
    financeClient.mockRejectedValue(new Error("Missing NEXT_PUBLIC_SUPABASE_URL"));
    await expect(getTickerPickupSafe("THYAO")).resolves.toBeNull();
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("reads the clock inside the cached attempt: the 30-day lookback is anchored on the call time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      let seen: { gte: Array<{ col: string; val: unknown }> } | undefined;
      const { getTickerPickup } = await loadWithClient({
        kap_disclosures: ((state: unknown) => {
          seen = state as typeof seen;
          return { data: [], error: null };
        }) as never,
      });
      const result = await getTickerPickup("THYAO");
      expect(result.until).toBe(iso(NOW));
      expect(result.since).toBe(iso(NOW - 30 * DAY));
      expect(seen?.gte[0]?.val).toBe(iso(NOW - 30 * DAY));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getTickerPickupSafe", () => {
  it("returns null when fetchTickerPickup throws", async () => {
    vi.doMock("@/lib/supabase/server", () => ({
      READER_TIMEOUT_MS: 4000,
      createFinanceServerClient: async () => ({}) as never,
    }));
    vi.doMock("@/lib/finance/kap-pickup-query", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/finance/kap-pickup-query")>();
      return actual;
    });

    // Force a real failure path: a client whose .from() is not a function.
    const { getTickerPickupSafe } = await import("@/lib/finance/kap-pickup-query");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await getTickerPickupSafe("THYAO");
    expect(result).toBeNull();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});
