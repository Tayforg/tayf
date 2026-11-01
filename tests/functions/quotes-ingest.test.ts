import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

type UpsertRow = Record<string, unknown>;
type UpsertError = { message: string; code: string };

const quotesTableState = vi.hoisted(() => ({
  /**
   * Per bar table: given the rows of the upsert being resolved, return the
   * PostgREST error to fail it with, or null to let it land. Unset = lands.
   */
  upsertError: {} as Record<string, ((rows: UpsertRow[]) => UpsertError | null) | undefined>,
}));

const quotesSupabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  const self: { fake?: ReturnType<typeof helper.createSupabaseFake> } = {};
  // The fake commits an upsert to its call log before it resolves the table
  // fixture, so the newest recorded upsert is the one being resolved.
  const upsertResult = (table: string) => () => {
    const last = self.fake?.calls.upsert(table).at(-1);
    const rows = Array.isArray(last?.patch) ? (last.patch as UpsertRow[]) : [];
    const error = quotesTableState.upsertError[table]?.(rows) ?? null;
    return { data: error ? null : [], error };
  };
  const fake = helper.createSupabaseFake({
    tables: {
      bist_bars_daily: upsertResult("bist_bars_daily"),
      bist_bars_5m: upsertResult("bist_bars_5m"),
    },
    rpc: {
      bist_daily_targets: () => ({ data: quotesRpcState.dailyTargets, error: null }),
      bist_intraday_targets: () => ({ data: quotesRpcState.intradayTargets, error: null }),
    },
  });
  self.fake = fake;
  return fake;
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
let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

/** Warnings about the daily settle stamp; other warnings (revalidation env) are not this test's business. */
const fetchedAtWarnings = () =>
  (warnSpy?.mock.calls ?? []).filter((c) => String(c[0]).includes("fetched_at"));

/** A daily chart with `n` consecutive Istanbul days ending at `last` (unix seconds, noon UTC). */
const dailySeries = (n: number, last: number) => Array.from({ length: n }, (_, i) => last - (n - 1 - i) * 86_400);

const dailyRows = () =>
  quotesSupabaseFake.calls.upsert("bist_bars_daily").flatMap((c) => c.patch as Array<Record<string, unknown>>);

describe("quotes-ingest runCycle", () => {
  beforeEach(() => {
    quotesRpcState.dailyTargets = [];
    quotesRpcState.intradayTargets = [];
    sentryCalls.captured.length = 0;
    fetchedRanges.clear();
    quotesSupabaseFake.calls.mutations.length = 0;
    quotesSupabaseFake.calls.rpc.length = 0;
    quotesTableState.upsertError = {};
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
    vi.useRealTimers();
    warnSpy?.mockRestore();
    warnSpy = undefined;
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

  // -------------------------------------------------------------------------
  // h11-finance-2 (migration 134): every daily upsert row carries fetched_at,
  // the tie-break bist_daily_targets() rotates on. The intraday table has no
  // such column and must never be sent one.
  // -------------------------------------------------------------------------
  describe("daily settle stamp (h11-finance-2)", () => {
    const day14 = utcSecs(2026, 8, 14, 12, 0);
    const day15 = utcSecs(2026, 8, 15, 12, 0);
    const day16 = utcSecs(2026, 8, 16, 12, 0);
    const RUN_START = "2026-10-30T15:45:00.000Z"; // 18:45 Istanbul, inside the settle window
    const pgrst204 = (rows: UpsertRow[]): UpsertError | null =>
      rows.some((r) => "fetched_at" in r)
        ? { message: "Could not find the 'fetched_at' column of 'bist_bars_daily' in the schema cache", code: "PGRST204" }
        : null;

    it("stamps every daily row with one fetched_at, taken at the start of the run, and keeps the 1y/1mo ranges and the day >= last_day filter", async () => {
      quotesRpcState.dailyTargets = [
        { ticker: "THYAO", last_day: "2026-09-15" },
        { ticker: "SAHOL", last_day: "2026-09-15" },
        { ticker: "EREGL", last_day: null },
      ];
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(RUN_START));
      // Time moves on while Yahoo is read: a stamp taken per ticker or per row
      // (or after the reads) would no longer equal the run's start.
      fetchImpl = async () => {
        vi.setSystemTime(Date.now() + 1_500);
        return new Response(JSON.stringify(chartPayload([day14, day15, day16])), { status: 200 });
      };

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.ok).toBe(true);
      expect(fetchedRanges.get("THYAO")).toBe("1mo");
      expect(fetchedRanges.get("EREGL")).toBe("1y");
      const rows = dailyRows();
      // THYAO / SAHOL: day >= last_day keeps 15 and 16; EREGL has no bar yet: all three.
      expect(rows.map((r) => `${r.ticker}:${r.day}`).sort()).toEqual([
        "EREGL:2026-09-14",
        "EREGL:2026-09-15",
        "EREGL:2026-09-16",
        "SAHOL:2026-09-15",
        "SAHOL:2026-09-16",
        "THYAO:2026-09-15",
        "THYAO:2026-09-16",
      ]);
      expect(rows.every((r) => r.fetched_at === RUN_START)).toBe(true);
      expect(rows.every((r) => new Date(String(r.fetched_at)).toISOString() === r.fetched_at)).toBe(true);
    });

    it("stamps every row of every upsert batch (1250 rows span two batches)", async () => {
      quotesRpcState.dailyTargets = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"].map((ticker) => ({ ticker, last_day: null }));
      fetchImpl = async () => new Response(JSON.stringify(chartPayload(dailySeries(250, day16))), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.bars).toBe(1250);
      const batches = quotesSupabaseFake.calls.upsert("bist_bars_daily").map((c) => c.patch as UpsertRow[]);
      expect(batches.map((b) => b.length)).toEqual([1000, 250]);
      const stamps = new Set(batches.flat().map((r) => r.fetched_at));
      expect(stamps.size).toBe(1);
      expect([...stamps][0]).toEqual(expect.any(String));
    });

    it("sends no fetched_at to the intraday table", async () => {
      const t0900 = utcSecs(2026, 8, 15, 9, 0);
      const t0905 = utcSecs(2026, 8, 15, 9, 5);
      quotesRpcState.intradayTargets = [{ ticker: "THYAO", last_ts: null }];
      fetchImpl = async () => new Response(JSON.stringify(chartPayload([t0900, t0905])), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      await runCycle({ mode: "intraday" });

      const rows = quotesSupabaseFake.calls.upsert("bist_bars_5m").flatMap((c) => c.patch as UpsertRow[]);
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => "fetched_at" in r)).toBe(false);
      expect(quotesSupabaseFake.calls.upsert("bist_bars_daily")).toHaveLength(0);
    });

    it("retries the daily batch without fetched_at on PGRST204 (134 not applied yet), warns once per isolate, and the rows land", async () => {
      vi.resetModules(); // fresh isolate: the once-per-isolate warning has not fired yet
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      quotesTableState.upsertError.bist_bars_daily = pgrst204;
      quotesRpcState.dailyTargets = [
        { ticker: "THYAO", last_day: "2026-09-15" },
        { ticker: "SAHOL", last_day: null },
      ];
      fetchImpl = async () => new Response(JSON.stringify(chartPayload([day14, day15, day16])), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.ok).toBe(true);
      expect(stats.bars).toBe(5);
      const upserts = quotesSupabaseFake.calls.upsert("bist_bars_daily");
      expect(upserts).toHaveLength(2);
      const [first, retry] = upserts.map((c) => c.patch as UpsertRow[]) as [UpsertRow[], UpsertRow[]];
      expect(first.every((r) => "fetched_at" in r)).toBe(true);
      expect(retry.some((r) => "fetched_at" in r)).toBe(false);
      // Same rows, only the column differs: nothing is lost or invented.
      const key = (r: UpsertRow) => `${r.ticker}:${r.day}:${r.close}:${r.volume}`;
      expect(retry.map(key).sort()).toEqual(first.map(key).sort());
      expect(retry).toHaveLength(5);

      expect(fetchedAtWarnings()).toHaveLength(1);
      expect(String(fetchedAtWarnings()[0]?.[0])).toContain("134");

      // The next cycle of the same isolate still lands its rows, without a second warning.
      quotesSupabaseFake.calls.mutations.length = 0;
      await runCycle({ mode: "daily" });
      expect(quotesSupabaseFake.calls.upsert("bist_bars_daily")).toHaveLength(2);
      expect(fetchedAtWarnings()).toHaveLength(1);
    });

    it("once a batch learned the column is missing, the batches after it skip fetched_at without another failed round trip", async () => {
      vi.resetModules();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      quotesTableState.upsertError.bist_bars_daily = pgrst204;
      quotesRpcState.dailyTargets = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"].map((ticker) => ({ ticker, last_day: null }));
      fetchImpl = async () => new Response(JSON.stringify(chartPayload(dailySeries(250, day16))), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.ok).toBe(true);
      const upserts = quotesSupabaseFake.calls.upsert("bist_bars_daily").map((c) => c.patch as UpsertRow[]);
      // batch 1 (fails) -> batch 1 without the column -> batch 2 without the column
      expect(upserts.map((b) => b.length)).toEqual([1000, 1000, 250]);
      const landed = upserts.slice(1).flat();
      expect(landed).toHaveLength(1250);
      expect(landed.some((r) => "fetched_at" in r)).toBe(false);
      expect(fetchedAtWarnings()).toHaveLength(1);
    });

    it("does not swallow any other daily upsert error: it throws, with no retry and no warning", async () => {
      vi.resetModules();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      quotesTableState.upsertError.bist_bars_daily = () => ({ message: "boom", code: "23505" });
      quotesRpcState.dailyTargets = [{ ticker: "THYAO", last_day: null }];
      fetchImpl = async () => new Response(JSON.stringify(chartPayload([day15, day16])), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      await expect(runCycle({ mode: "daily" })).rejects.toThrow("[quotes-ingest] bist_bars_daily upsert: boom");

      expect(quotesSupabaseFake.calls.upsert("bist_bars_daily")).toHaveLength(1);
      expect(fetchedAtWarnings()).toHaveLength(0);
    });

    it("never applies the fetched_at fallback to the intraday table: a PGRST204 there still throws", async () => {
      vi.resetModules();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      quotesTableState.upsertError.bist_bars_5m = () => ({ message: "no such column", code: "PGRST204" });
      quotesRpcState.intradayTargets = [{ ticker: "THYAO", last_ts: null }];
      fetchImpl = async () =>
        new Response(JSON.stringify(chartPayload([utcSecs(2026, 8, 15, 9, 0)])), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      await expect(runCycle({ mode: "intraday" })).rejects.toThrow("[quotes-ingest] bist_bars_5m upsert: no such column");

      expect(quotesSupabaseFake.calls.upsert("bist_bars_5m")).toHaveLength(1);
      expect(fetchedAtWarnings()).toHaveLength(0);
    });

    it("daily mode: a ticker Yahoo rejects is listed in failed and the cycle still stamps and writes the others (ok stays true)", async () => {
      quotesRpcState.dailyTargets = [
        { ticker: "THYAO", last_day: "2026-09-15" },
        { ticker: "SAHOL", last_day: "2026-09-15" },
      ];
      fetchImpl = async (url) =>
        new URL(url).pathname.includes("SAHOL")
          ? new Response("server error", { status: 500 })
          : new Response(JSON.stringify(chartPayload([day15, day16])), { status: 200 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.ok).toBe(true);
      expect(stats.fetched).toBe(1);
      expect(stats.failed).toEqual(["SAHOL:yahoo 500"]);
      expect(sentryCalls.captured).toHaveLength(0);
      const rows = dailyRows();
      expect(rows.map((r) => r.ticker)).toEqual(["THYAO", "THYAO"]);
      expect(rows.every((r) => typeof r.fetched_at === "string")).toBe(true);
    });

    it("daily mode: returns ok:false, captures once and writes nothing when every ticker fails (SEC-05)", async () => {
      quotesRpcState.dailyTargets = [
        { ticker: "THYAO", last_day: "2026-09-15" },
        { ticker: "SAHOL", last_day: "2026-09-15" },
      ];
      fetchImpl = async () => new Response("server error", { status: 500 });

      const { runCycle } = await import("../../supabase/functions/quotes-ingest/index.ts");
      const stats = await runCycle({ mode: "daily" });

      expect(stats.ok).toBe(false);
      expect(stats.failed).toHaveLength(2);
      expect(sentryCalls.captured).toHaveLength(1);
      expect(sentryCalls.captured[0]?.fn).toBe("quotes-ingest");
      expect(quotesSupabaseFake.calls.upsert("bist_bars_daily")).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// h11-finance-2: bist_daily_targets() must rotate through every traded ticker.
//
// PURE MODEL of the SQL ordering. The SQL text itself is pinned by
// tests/migrations/134-bist-daily-settle.test.ts; the first test here also
// reads the order-by clause out of migration 134 and compares it with the
// model's sort keys, so the model cannot drift from the SQL it stands for.
//
//   134: order by b.last_day nulls first, b.last_fetched nulls first, t.ticker limit p_limit
//   052: order by b.last_day nulls first, t.ticker limit p_limit        (the bug)
//
// quotes-daily (058:586, '12-59/3 15-16 * * 1-5' UTC) runs from 18:12 to
// 19:57 Istanbul; the BIST closing auction settles around 18:08-18:10 and the
// first pass after it still carries the pre-auction bar. Every ticker has to be
// read again once Yahoo has settled, i.e. at or after 18:40.
// ---------------------------------------------------------------------------

type SortKey = "last_day" | "last_fetched" | "ticker";
const ORDER_NEW: SortKey[] = ["last_day", "last_fetched", "ticker"];
const ORDER_OLD: SortKey[] = ["last_day", "ticker"];

interface ModelRow {
  ticker: string;
  lastDay: string | null;
  /** epoch ms of the newest fetch of the ticker's newest bar; null before 134 / never fetched */
  lastFetched: number | null;
}

/** `nulls first`, ascending: how both last_day and last_fetched sort in the SQL. */
function compareNullsFirst<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function pickTargets(rows: ModelRow[], order: SortKey[], limit: number): ModelRow[] {
  const value = (r: ModelRow, key: SortKey) =>
    key === "last_day" ? r.lastDay : key === "last_fetched" ? r.lastFetched : r.ticker;
  return [...rows]
    .sort((a, b) => {
      for (const key of order) {
        const c = compareNullsFirst<string | number>(value(a, key), value(b, key));
        if (c !== 0) return c;
      }
      return 0;
    })
    .slice(0, limit);
}

const SESSION_DAY = "2026-10-30";
const PREVIOUS_DAY = "2026-10-29";
/** Epoch ms of an Istanbul wall-clock time on the session day (UTC+3, no DST). */
const ist = (h: number, m: number) => Date.UTC(2026, 9, 30, h - 3, m);
const SETTLED_FROM = ist(18, 40);
const RUN_INTERVAL_MS = 3 * 60_000;
const DAILY_LIMIT = 80;

/** Every 3 minutes from 18:12 to 19:57 Istanbul: 36 runs. */
const EVERY_THREE_MINUTES: number[] = Array.from({ length: 36 }, (_, i) => ist(18, 12) + i * RUN_INTERVAL_MS);
/** The real pg_cron schedule '12-59/3 15-16' UTC: 18:12-18:57 and 19:12-19:57 Istanbul, 32 runs with a gap at the hour. */
const CRON_RUNS: number[] = [18, 19].flatMap((h) => Array.from({ length: 16 }, (_, i) => ist(h, 12 + i * 3)));

const healthyTickers = (n: number) => Array.from({ length: n }, (_, i) => `T${String(i).padStart(3, "0")}`);

/**
 * Runs one session of target selection. A fetched ticker gets today's bar (last_day = session day)
 * and fetched_at = the run time, exactly as quotes-ingest upserts it. `idle` tickers have no bar for
 * today (suspended / delisted): their newest bar is re-stamped but last_day never advances, and a
 * ticker with no bar at all (last_day null) has nothing to stamp.
 */
function simulate(opts: {
  rows: ModelRow[];
  idle?: ReadonlySet<string>;
  order: SortKey[];
  runs: number[];
}): { fetches: Map<string, number[]>; rows: ModelRow[]; perRun: string[][] } {
  const rows = opts.rows.map((r) => ({ ...r }));
  const fetches = new Map<string, number[]>(rows.map((r) => [r.ticker, []]));
  const perRun: string[][] = [];
  for (const runAt of opts.runs) {
    const targets = pickTargets(rows, opts.order, DAILY_LIMIT);
    perRun.push(targets.map((t) => t.ticker));
    for (const t of targets) {
      fetches.get(t.ticker)!.push(runAt);
      if (opts.idle?.has(t.ticker)) {
        if (t.lastDay !== null) t.lastFetched = runAt;
      } else {
        t.lastDay = SESSION_DAY;
        t.lastFetched = runAt;
      }
    }
  }
  return { fetches, rows, perRun };
}

const neverSettled = (fetches: Map<string, number[]>, tickers: string[]) =>
  tickers.filter((t) => !(fetches.get(t) ?? []).some((at) => at >= SETTLED_FROM));

/** 625 traded tickers whose newest bar is yesterday's and whose fetched_at is null (rows from before 134). */
const preMigrationRows = (): ModelRow[] =>
  healthyTickers(625).map((ticker) => ({ ticker, lastDay: PREVIOUS_DAY, lastFetched: null }));

describe("bist_daily_targets rotation (h11-finance-2, migration 134)", () => {
  it("the model sorts by the same keys, in the same order, as the order-by clause of migration 134", () => {
    const sql = readFileSync(resolve(__dirname, "../../supabase/migrations/134_bist_daily_settle.sql"), "utf8")
      .replace(/--[^\n]*/g, "");
    // The outer order by: the one directly before `limit p_limit` (the lateral probe has its own).
    const m = /order\s+by\s+((?:(?!order\s+by)[\s\S])*?)\s+limit\s+p_limit\b/i.exec(sql);
    expect(m, "order by ... limit p_limit").not.toBeNull();
    const terms = (m as RegExpExecArray)[1]!.split(",").map((t) => t.replace(/\s+/g, " ").trim());
    // last_day and last_fetched are nullable: the model sorts a null before any value.
    expect(terms).toEqual(["b.last_day nulls first", "b.last_fetched nulls first", "t.ticker"]);
    expect(terms.map((t) => /^[bt]\.(\w+)/.exec(t)![1])).toEqual(ORDER_NEW);
  });

  it("re-reads every one of 625 tickers at or after 18:40 when 80 are fetched every 3 minutes from 18:12 to 19:57", () => {
    const { fetches, rows, perRun } = simulate({ rows: preMigrationRows(), order: ORDER_NEW, runs: EVERY_THREE_MINUTES });

    expect(perRun).toHaveLength(36);
    for (const run of perRun) expect(new Set(run).size).toBe(DAILY_LIMIT);

    expect(neverSettled(fetches, healthyTickers(625))).toEqual([]);

    // The first pass reaches everybody within ceil(625 / 80) = 8 runs (18:12-18:33) ...
    const firstFetch = Math.max(...[...fetches.values()].map((at) => at[0]!));
    expect(firstFetch).toBeLessThanOrEqual(ist(18, 12) + 7 * RUN_INTERVAL_MS);
    // ... and from then on no ticker waits longer than one full rotation (8 runs, 24 minutes).
    for (const [ticker, at] of fetches) {
      for (let i = 1; i < at.length; i++) {
        expect(at[i]! - at[i - 1]!, `${ticker} gap before ${new Date(at[i]!).toISOString()}`).toBeLessThanOrEqual(
          8 * RUN_INTERVAL_MS,
        );
      }
    }
    // The stalest bar of the day was read within the last rotation, not at 18:12.
    expect(Math.min(...[...fetches.values()].map((at) => at[at.length - 1]!))).toBeGreaterThanOrEqual(ist(19, 36));
    expect(rows.every((r) => r.lastDay === SESSION_DAY)).toBe(true);
  });

  it("proves the test can catch the bug: the old order (last_day, ticker) leaves 545 of the 625 on their first pass", () => {
    const { fetches, perRun } = simulate({ rows: preMigrationRows(), order: ORDER_OLD, runs: EVERY_THREE_MINUTES });

    const starved = neverSettled(fetches, healthyTickers(625));
    // Once everyone holds today's bar the same alphabetical first 80 are picked again and again.
    expect(starved).toHaveLength(625 - DAILY_LIMIT);
    expect(starved).toContain("T624");
    expect(starved).not.toContain("T000");
    expect(new Set(perRun.slice(-10).map((run) => run.join(","))).size).toBe(1);
    expect(perRun[35]).toEqual(healthyTickers(DAILY_LIMIT));
  });

  it("holds on the production shape: 631 traded tickers, 6 of them without today's bar, the real 32-run cron schedule", () => {
    // Read-only production, 2026-11-01: 631 traded tickers of 4+ characters, 625 with the 2026-10-30
    // bar; KTEST has no bar at all, ISKUR stops at 2026-08-12, UMPAS / TERA / ISATR / TRHOL at 2026-10-28.
    const idleBars: Array<[string, string | null]> = [
      ["KTEST", null],
      ["ISKUR", "2026-08-12"],
      ["UMPAS", "2026-10-28"],
      ["TERA", "2026-10-28"],
      ["ISATR", "2026-10-28"],
      ["TRHOL", "2026-10-28"],
    ];
    const rows: ModelRow[] = [
      ...preMigrationRows(),
      ...idleBars.map(([ticker, lastDay]) => ({ ticker, lastDay, lastFetched: null })),
    ];
    const idle = new Set(idleBars.map(([ticker]) => ticker));

    expect(rows).toHaveLength(631);
    const fixed = simulate({ rows, idle, order: ORDER_NEW, runs: CRON_RUNS });
    expect(CRON_RUNS).toHaveLength(32);
    expect(neverSettled(fixed.fetches, healthyTickers(625))).toEqual([]);

    const buggy = simulate({ rows, idle, order: ORDER_OLD, runs: CRON_RUNS });
    expect(neverSettled(buggy.fetches, healthyTickers(625)).length).toBeGreaterThan(400);
  });
});
