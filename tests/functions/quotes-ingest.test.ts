import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { istDay, parseDailyBars, parseIntradayBars, yahooChartUrl } from "../../supabase/functions/_shared/bars.ts";

// Shapes captured from query1.finance.yahoo.com on 2026-09-14 (THYAO.IS).
const daily = {
  chart: {
    result: [
      {
        timestamp: [1789367400, 1789453800, 1789453800],
        indicators: {
          quote: [
            {
              open: [298, 300, 300.5],
              high: [302, 303, 303],
              low: [296, 299, 299],
              close: [299.25, null, 300.25],
              volume: [38386110, 36184804, 36184805],
            },
          ],
        },
      },
    ],
  },
};

describe("bars", () => {
  it("builds the Yahoo URL for a BIST code", () => {
    expect(yahooChartUrl("THYAO", "1d", "5m")).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/THYAO.IS?range=1d&interval=5m",
    );
  });

  it("maps daily bars to Istanbul dates, drops null closes, keeps the last repeat", () => {
    const rows = parseDailyBars("THYAO", daily);
    expect(rows.map((r) => r.day)).toEqual([istDay(1789367400), istDay(1789453800)]);
    expect(rows[1]).toMatchObject({ close: 300.25, volume: 36184805 });
  });

  it("floors intraday timestamps to the 5-minute grid", () => {
    const rows = parseIntradayBars("THYAO", {
      chart: {
        result: [
          {
            timestamp: [1789368900, 1789369200, 1789369311],
            indicators: { quote: [{ close: [297, 297.5, 297.5], volume: [10, 20, 5] }] },
          },
        ],
      },
    });
    // 1789369311 floors to 1789369200 and overwrites that bar.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ts: new Date(1789369200 * 1000).toISOString(), close: 297.5, volume: 5 });
  });

  it("returns nothing for an error payload", () => {
    expect(parseDailyBars("X", { chart: { result: null } })).toEqual([]);
    expect(parseIntradayBars("X", {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// quotes-ingest runCycle contract tests.
//
// Same convention as tests/functions/kap-ingest.test.ts / cluster-consumer.
// test.ts: polyfill Deno, mock the Supabase factory with the shared proxy
// fake (tests/_helpers/supabase-fake.ts) and Sentry's captureException,
// stub `fetch` per test to control Yahoo's response per ticker.
// ---------------------------------------------------------------------------

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __quotesIngestHandler?: unknown }).__quotesIngestHandler = handler;
    return { finished: Promise.resolve() };
  },
};

const quotesRpcState = vi.hoisted(() => ({
  dailyTargets: [] as Array<{ ticker: string; last_day: string | null }>,
  // DB-03: bist_intraday_targets(int) itself now carries each ticker's own
  // last_ts (058's `b` subquery), so the watermark is seeded straight from
  // this RPC's rows — there is no longer a separate bist_bars_5m read.
  intradayTargets: [] as Array<{ ticker: string; last_ts?: string | null }>,
}));

const sentryCalls = vi.hoisted(() => ({
  captured: [] as Array<{ fn: string; err: unknown }>,
}));

const quotesSupabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      bist_daily_targets: () => ({ data: quotesRpcState.dailyTargets, error: null }),
      bist_intraday_targets: () => ({ data: quotesRpcState.intradayTargets, error: null }),
    },
  });
});

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => quotesSupabaseFake.client,
}));

vi.mock("../../supabase/functions/_shared/sentry.ts", () => ({
  initSentry: async () => {},
  captureException: (fn: string, err: unknown) => {
    sentryCalls.captured.push({ fn, err });
  },
  withSentry:
    (_fn: string, handler: (req: Request) => Promise<Response> | Response) => handler,
}));

/** Minimal Yahoo chart payload: one quote series over the given unix-second timestamps. */
function chartPayload(unixSeconds: number[]): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: unixSeconds,
          indicators: {
            quote: [
              {
                open: unixSeconds.map(() => null),
                high: unixSeconds.map(() => null),
                low: unixSeconds.map(() => null),
                close: unixSeconds.map(() => 100),
                volume: unixSeconds.map(() => 10),
              },
            ],
          },
        },
      ],
    },
  };
}

const utcSecs = (y: number, m: number, d: number, h: number, min: number) =>
  Date.UTC(y, m, d, h, min, 0) / 1000;

type FetchImpl = (url: string, init: RequestInit) => Promise<Response> | Response;
let fetchImpl: FetchImpl = async () => new Response(JSON.stringify(chartPayload([])), { status: 200 });
const fetchedRanges = new Map<string, string>();

describe("quotes-ingest runCycle", () => {
  beforeEach(() => {
    quotesRpcState.dailyTargets = [];
    quotesRpcState.intradayTargets = [];
    sentryCalls.captured.length = 0;
    fetchedRanges.clear();
    quotesSupabaseFake.calls.mutations.length = 0;
    quotesSupabaseFake.calls.rpc.length = 0;
    fetchImpl = async () => new Response(JSON.stringify(chartPayload([])), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const ticker = u.pathname.split("/").pop()!.replace(".IS", "");
        fetchedRanges.set(ticker, u.searchParams.get("range") ?? "");
        return fetchImpl(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls bist_intraday_targets with p_limit (TS-02)", async () => {
    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    await runCycle({ mode: "intraday" });

    const call = quotesSupabaseFake.calls.rpc.find((c) => c.name === "bist_intraday_targets");
    expect(call?.args).toEqual({ p_limit: 120 });
  });

  it("upserts only bars at/after the existing watermark, and gives a bar-less ticker the full 5d warmup (DB-03)", async () => {
    const t0855 = utcSecs(2026, 8, 15, 8, 55);
    const t0900 = utcSecs(2026, 8, 15, 9, 0);
    const t0905 = utcSecs(2026, 8, 15, 9, 5);
    // The watermark now comes straight off bist_intraday_targets(int)'s own
    // last_ts column (058's `b` subquery) — no separate bist_bars_5m read.
    quotesRpcState.intradayTargets = [
      { ticker: "THYAO", last_ts: new Date(t0900 * 1000).toISOString() },
      { ticker: "SAHOL", last_ts: null },
    ];

    fetchImpl = async (url) => {
      const ticker = new URL(url).pathname.split("/").pop()!.replace(".IS", "");
      const timestamps = ticker === "THYAO" ? [t0855, t0900, t0905] : [t0855, t0900, t0905];
      return new Response(JSON.stringify(chartPayload(timestamps)), { status: 200 });
    };

    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    const stats = await runCycle({ mode: "intraday" });

    expect(stats.ok).toBe(true);
    expect(fetchedRanges.get("THYAO")).toBe("1d");
    expect(fetchedRanges.get("SAHOL")).toBe("5d");

    const rows = quotesSupabaseFake.calls
      .upsert("bist_bars_5m")
      .flatMap((c) => c.patch as Array<{ ticker: string; ts: string }>);
    const thyaoTs = rows.filter((r) => r.ticker === "THYAO").map((r) => r.ts).sort();
    expect(thyaoTs).toEqual([new Date(t0900 * 1000).toISOString(), new Date(t0905 * 1000).toISOString()]);
    expect(rows.filter((r) => r.ticker === "SAHOL")).toHaveLength(3);
  });

  it("carries the watermark for every target past a 25-ticker page, not just an arbitrary slice (DB-03 regression)", async () => {
    // The truncation this guards against: a flat, ungrouped, LIMIT-capped
    // bist_bars_5m read returned only ~25 tickers' worth of an ~23,000-row
    // two-day window, so every ticker outside that arbitrary slice fell
    // through to `last === undefined` and got the full, unfiltered 5d
    // warmup every cycle. Driving > 25 targets, each with its own last_ts
    // from bist_intraday_targets(int) directly, must not lose any of them.
    const t0900 = utcSecs(2026, 8, 15, 9, 0);
    const t0905 = utcSecs(2026, 8, 15, 9, 5);
    const n = 40;
    quotesRpcState.intradayTargets = Array.from({ length: n }, (_, i) => ({
      ticker: `T${String(i).padStart(3, "0")}`,
      last_ts: new Date(t0900 * 1000).toISOString(),
    }));

    fetchImpl = async () => new Response(JSON.stringify(chartPayload([t0900, t0905])), { status: 200 });

    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    const stats = await runCycle({ mode: "intraday" });

    expect(stats.ok).toBe(true);
    expect(stats.tickers).toBe(n);
    for (let i = 0; i < n; i++) {
      const ticker = `T${String(i).padStart(3, "0")}`;
      expect(fetchedRanges.get(ticker), `${ticker} range`).toBe("1d");
    }

    const rows = quotesSupabaseFake.calls
      .upsert("bist_bars_5m")
      .flatMap((c) => c.patch as Array<{ ticker: string; ts: string }>);
    // Every target's own watermark (>=) re-upserts the last known (possibly
    // still-partial) bar plus the genuinely new one — two rows per ticker,
    // not the full unfiltered 5d warmup a truncated/missing watermark would
    // have produced.
    for (let i = 0; i < n; i++) {
      const ticker = `T${String(i).padStart(3, "0")}`;
      const tickerTs = rows.filter((r) => r.ticker === ticker).map((r) => r.ts).sort();
      expect(tickerTs, `${ticker} upserted rows`).toEqual([
        new Date(t0900 * 1000).toISOString(),
        new Date(t0905 * 1000).toISOString(),
      ]);
    }
  });

  it("applies the same watermark guard to daily mode via last_day", async () => {
    quotesRpcState.dailyTargets = [{ ticker: "THYAO", last_day: "2026-09-15" }];
    const day14 = utcSecs(2026, 8, 14, 12, 0);
    const day15 = utcSecs(2026, 8, 15, 12, 0);
    const day16 = utcSecs(2026, 8, 16, 12, 0);
    fetchImpl = async () => new Response(JSON.stringify(chartPayload([day14, day15, day16])), { status: 200 });

    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    await runCycle({ mode: "daily" });

    const rows = quotesSupabaseFake.calls
      .upsert("bist_bars_daily")
      .flatMap((c) => c.patch as Array<{ day: string }>);
    expect(rows.map((r) => r.day).sort()).toEqual(["2026-09-15", "2026-09-16"]);
  });

  it("returns ok:false and captures once when every ticker fails (SEC-05)", async () => {
    quotesRpcState.intradayTargets = [{ ticker: "THYAO" }, { ticker: "SAHOL" }];
    fetchImpl = async () => new Response("server error", { status: 500 });

    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    const stats = await runCycle({ mode: "intraday" });

    expect(stats.ok).toBe(false);
    expect(stats.failed).toHaveLength(2);
    expect(sentryCalls.captured).toHaveLength(1);
    expect(sentryCalls.captured[0]?.fn).toBe("quotes-ingest");
  });

  it("sends an honest, contactable User-Agent to Yahoo", async () => {
    quotesRpcState.intradayTargets = [{ ticker: "THYAO" }];
    let capturedHeaders: Record<string, string> | undefined;
    fetchImpl = async (_url, init) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify(chartPayload([])), { status: 200 });
    };

    const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
    await runCycle({ mode: "intraday" });

    // SEC-06/TS-03: reuses the identity the repo already publishes and that
    // already resolves (tayf.app), not the fabricated tayfhaber.com/bot URL
    // (src/app/ ships no `bot` route, so that identity 404s).
    expect(capturedHeaders?.["User-Agent"]).toContain("+https://tayf.app");
    expect(capturedHeaders?.["User-Agent"]).not.toContain("tayfhaber.com");
    expect(capturedHeaders?.["User-Agent"]).not.toContain("Windows NT");
    expect(capturedHeaders?.["User-Agent"]).not.toContain("Chrome");
  });
});
