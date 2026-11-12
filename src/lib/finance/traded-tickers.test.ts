import { beforeEach, describe, expect, it, vi } from "vitest";

// h153: the set of traded BIST codes the home search checks a one-word query
// against. tradedTickerCodes is the pure part; getTradedTickers is the cached
// reader behind it (one paged read of bist_companies per `hours`, remote cache,
// null contract with no live retry).

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

type Envelope = { data: unknown; error: { message: string } | null };

const fixture = vi.hoisted(() => ({
  /** One envelope per page request, consumed in order; the last repeats. */
  pages: [] as Envelope[],
  served: 0,
  states: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      bist_companies: (state: unknown) => {
        fixture.states.push(state);
        const i = Math.min(fixture.served, fixture.pages.length - 1);
        fixture.served += 1;
        return fixture.pages[i] as Envelope;
      },
    },
  });
});

const clients = vi.hoisted(() => ({ finance: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  READER_TIMEOUT_MS: 4000,
  createFinanceServerClient: clients.finance,
}));

import { cacheLife, cacheTag } from "next/cache";
import { getTradedTickers, tradedTickerCodes } from "./traded-tickers";

const ok = (data: unknown): Envelope => ({ data, error: null });
const fail = (message: string): Envelope => ({ data: null, error: { message } });

type State = {
  selectArgs: unknown[];
  eq: Array<{ col: string; val: unknown }>;
  order: Array<{ col: string; opts: unknown }>;
  range: { from: number; to: number } | null;
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fixture.pages = [ok([{ kap_member_oid: "1", tickers: ["THYAO"] }])];
  fixture.served = 0;
  fixture.states = [];
  clients.finance.mockReset();
  clients.finance.mockResolvedValue(supabaseFake.client);
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("tradedTickerCodes", () => {
  it("dedupes and sorts the codes of every row", () => {
    expect(
      tradedTickerCodes([{ tickers: ["THYAO"] }, { tickers: ["GARAN", "TGB"] }, { tickers: ["THYAO"] }]),
    ).toEqual(["GARAN", "TGB", "THYAO"]);
  });

  it("drops a non-equity code", () => {
    expect(tradedTickerCodes([{ tickers: ["KTEST", "THYAO"] }])).toEqual(["THYAO"]);
    expect(tradedTickerCodes([{ tickers: ["KTEST"] }])).toEqual([]);
  });

  it("skips a row whose tickers are not an array and an entry that is not a string", () => {
    expect(tradedTickerCodes([{ tickers: null }, { tickers: "THYAO" }, { tickers: [1, "AKBNK"] }])).toEqual([
      "AKBNK",
    ]);
    expect(tradedTickerCodes([{}, { tickers: undefined }, { tickers: [null, undefined, {}] }])).toEqual([]);
  });

  it("gives an empty list for no rows", () => {
    expect(tradedTickerCodes([])).toEqual([]);
  });

  it("copes with 10k rows", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ tickers: [`C${String(i % 700).padStart(4, "0")}`] }));
    expect(tradedTickerCodes(rows)).toHaveLength(700);
  });
});

describe("getTradedTickers", () => {
  it("reads the traded companies through the capped finance client and returns the sorted codes", async () => {
    fixture.pages = [
      ok([
        { kap_member_oid: "1", tickers: ["THYAO"] },
        { kap_member_oid: "2", tickers: ["KCHOL"] },
        { kap_member_oid: "3", tickers: ["KTEST"] },
      ]),
    ];

    expect(await getTradedTickers()).toEqual(["KCHOL", "THYAO"]);

    expect(clients.finance).toHaveBeenCalledTimes(1);
    expect(clients.finance).toHaveBeenCalledWith({ timeoutMs: 4000 });
    const state = fixture.states[0] as State;
    expect(String(state.selectArgs[0]).split(",").map((c) => c.trim())).toEqual(["kap_member_oid", "tickers"]);
    expect(state.eq).toEqual([{ col: "shares_traded", val: true }]);
    expect(state.order).toEqual([{ col: "kap_member_oid", opts: undefined }]);
    expect(state.range).toEqual({ from: 0, to: 999 });
  });

  it("tags the entry finance-companies and keeps the hours lifetime on success, once", async () => {
    await getTradedTickers();
    expect(cacheTag).toHaveBeenCalledWith("finance-companies");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("returns [] (not null) for a read that came back empty", async () => {
    fixture.pages = [ok([])];
    expect(await getTradedTickers()).toEqual([]);
  });

  it("pages through a full first page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ kap_member_oid: String(i), tickers: [`AB${i}`] }));
    fixture.pages = [ok(full), ok([{ kap_member_oid: "x", tickers: ["THYAO"] }])];

    const codes = await getTradedTickers();

    expect(fixture.served).toBe(2);
    expect((fixture.states[1] as State).range).toEqual({ from: 1000, to: 1999 });
    expect(codes).toContain("THYAO");
    expect(codes).toHaveLength(1001);
  });

  it("returns null on a failed read, memoises it for minutes only and does NOT retry live", async () => {
    fixture.pages = [fail("canceling statement due to statement timeout"), ok([{ kap_member_oid: "1", tickers: ["THYAO"] }])];

    expect(await getTradedTickers()).toBeNull();

    // One request only: the healthy second envelope was never consumed.
    expect(fixture.served).toBe(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("never throws: a client that cannot be built comes back as null", async () => {
    clients.finance.mockRejectedValue(new Error("Missing NEXT_PUBLIC_SUPABASE_URL"));
    await expect(getTradedTickers()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});
