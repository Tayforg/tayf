import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// kap-media-pickup — IO layer tests. Uses the shared chainable Supabase
// fake (tests/_helpers/supabase-fake.ts) directly against fetchTickerPickup
// (no createServerClient/createFinanceServerClient indirection needed
// there), and mocks next/cache + @/lib/supabase/server separately for the
// "use cache" getTickerPickup(Safe) wrappers.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-28T12:00:00.000Z").getTime();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

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

describe("getTickerPickupSafe", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when fetchTickerPickup throws", async () => {
    vi.doMock("@/lib/supabase/server", () => ({
      createFinanceServerClient: async () => ({}) as never,
    }));
    vi.doMock("@/lib/finance/kap-pickup-query", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/finance/kap-pickup-query")>();
      return actual;
    });

    // Force a real failure path: no env vars / a client whose .from() throws.
    const { getTickerPickupSafe } = await import("@/lib/finance/kap-pickup-query");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getTickerPickupSafe("THYAO");
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});
