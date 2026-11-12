import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { NOT_CIRCUIT_BREAKER_OR, tickerDisclosureOr } from "./disclosure-filter";
import { createFinanceFakeClient } from "./dev-fixtures";

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

// ---------------------------------------------------------------------------
// Permanent guard for SEC-09/TS-07.
//
// The dev-only fixture client (createFinanceFakeClient, this directory's
// dev-fixtures.ts) used to import the shared chainable test helper from
// tests/_helpers/supabase-fake, which put a test-only module on the
// production bundle graph behind nothing but a runtime env check
// (NODE_ENV !== 'production' && TAYF_FAKE_FINANCE === '1', a branch
// webpack/Next can't tree-shake away). dev-fixtures.ts now inlines its own
// small fake instead (see below in this same file) and no longer imports
// tests/_helpers at all.
//
// This is the repo-wide sweep so the same mistake can't land anywhere else
// under src/: no non-test .ts/.tsx file should reference tests/_helpers.
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_EXT_RE = /\.test\.(ts|tsx)$/;
const SRC_EXT_RE = /\.(ts|tsx)$/;

function walkNonTestSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkNonTestSourceFiles(full, out);
      continue;
    }
    if (SRC_EXT_RE.test(entry) && !TEST_EXT_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("finance dev-fixtures / production bundle graph boundary", () => {
  it("no file under src/ outside *.test.ts(x) references tests/_helpers (SEC-09/TS-07)", () => {
    const offenders = walkNonTestSourceFiles(SRC_ROOT).filter((f) => readFileSync(f, "utf8").includes("tests/_helpers"));
    expect(offenders).toEqual([]);
  });
});

describe("reader-data: /ekonomi still renders end-to-end under TAYF_FAKE_FINANCE=1", () => {
  it("fetchEconFeed / fetchTopTickers / fetchTickerPage all resolve without throwing against the fake client", async () => {
    const ORIGINAL_ENV = { ...process.env };
    process.env.NODE_ENV = "development";
    process.env.TAYF_FAKE_FINANCE = "1";
    try {
      // createFinanceServerClient() (src/lib/supabase/server.ts) checks
      // NODE_ENV + TAYF_FAKE_FINANCE itself and dynamically imports
      // dev-fixtures.ts directly — no @supabase/supabase-js mock needed.
      const queries = await import("./queries");

      const feed = await queries.fetchEconFeed(80);
      expect(Array.isArray(feed)).toBe(true);
      expect(feed.length).toBeGreaterThan(0);

      const top = await queries.fetchTopTickers(2, 24);
      expect(Array.isArray(top)).toBe(true);

      const page = await queries.fetchTickerPage("THYAO");
      expect(page.attention).toBeDefined();
      expect(Array.isArray(page.articles)).toBe(true);
    } finally {
      process.env = ORIGINAL_ENV;
      vi.resetModules();
    }
  });
});

describe("h11-finance-1: the dev fake honours the ticker inside the combined or() string", () => {
  type Row = { disclosure_index: number; stock_codes: string[]; related_stocks: string[]; subject: string | null; summary: string | null };
  type Query = {
    select: (cols: string, opts?: { count?: string; head?: boolean }) => Query;
    or: (f: string) => Query;
    gte: (c: string, v: string) => Query;
    order: (c: string, o?: unknown) => Query;
    limit: (n: number) => Query;
    then: (f: (v: { data: Row[] | null; count?: number; error: null }) => unknown) => unknown;
  };
  const kap = () => (createFinanceFakeClient() as { from: (t: string) => Query }).from("kap_disclosures");
  const read = async (q: Query) => (await (q as unknown as Promise<{ data: Row[] | null; count?: number }>)).data ?? [];

  it("returns only that ticker's notices, from stock_codes or from related_stocks, breakers excluded", async () => {
    const rows = await read(kap().select("*").or(tickerDisclosureOr("THYAO")).limit(60));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect([...r.stock_codes, ...r.related_stocks]).toContain("THYAO");
    expect(rows.some((r) => /devre kesici/i.test(r.subject ?? ""))).toBe(false);
  });

  it("SASA: its devre kesici notice is skipped, but the related_stocks-only halt notice is listed", async () => {
    const rows = await read(kap().select("*").or(tickerDisclosureOr("SASA")).limit(60));
    expect(rows.map((r) => r.subject)).not.toContain("Pay Bazında Devre Kesici Bildirimi");
    const halt = rows.find((r) => r.stock_codes.length === 0);
    expect(halt?.related_stocks).toEqual(["SASA"]);
    expect(halt?.summary).toBe("Pay Sırasının İşleme Kapatılması");
  });

  it("an unknown ticker matches nothing", async () => {
    expect(await read(kap().select("*").or(tickerDisclosureOr("ZZZZ")).limit(60))).toEqual([]);
  });

  it("without a ticker the plain breaker or() lists the non-breaker stream across tickers", async () => {
    const rows = await read(kap().select("*").or(NOT_CIRCUIT_BREAKER_OR).order("published_at", { ascending: false }).limit(40));
    expect(new Set(rows.flatMap((r) => r.stock_codes)).size).toBeGreaterThan(3);
    expect(rows.some((r) => /devre kesici/i.test(r.subject ?? ""))).toBe(false);
  });

  it("a head:true count read returns the count and no rows, ignoring limit", async () => {
    const q = kap().select("disclosure_index", { count: "exact", head: true }).or(tickerDisclosureOr("THYAO"));
    const res = await (q as unknown as Promise<{ data: Row[] | null; count?: number }>);
    expect(res.data).toBeNull();
    expect(res.count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// h150: the fixture's price_at() equivalent follows migration 203.
//
// Production price_at(p_ticker, p_ts) returns the close of the last COMPLETED 5-minute bar: bist_bars_5m is
// start-stamped, so a bar stamped T is complete from T + 5 min on (ts <= p_ts - 5 minutes, inclusive), and 187's
// daily-close and session-day rules still apply. The fixture's copy is reachable through the feed_reference_prices
// RPC, which prices an article at its published_at. THYAO's article a01 is published 0.4 h before "now", so pinning
// "now" to headline + 0.4 h puts that headline exactly where a case needs it (the harness checks it).
//
// Cases mirror 203's five edge cases (tests/migrations/sql/203-price-at-completed-bar-dryrun.sql) on the fixture's
// own rows: the expected value is always read from bist_bars_5m / bist_quote_stats, never typed in, and each case
// also asserts that the answer differs from what the old containing-bar rule would have said.
// ---------------------------------------------------------------------------

describe("h150: the fixture price_at() reads the last completed 5-minute bar (migration 203)", () => {
  type Bar = { ticker: string; ts: string; close: number; volume: number };
  type Reader = {
    rpc: (name: string, args: unknown) => Promise<{ data: Array<Record<string, unknown>> | null }>;
    from: (table: string) => { eq: (c: string, v: string) => unknown };
  };

  const DAY = "2026-11-11"; // a Wednesday, 203's own fixture day
  const PREV_DAY = "2026-11-10";
  const HOUR_MS = 60 * 60 * 1000;
  const A01_AGO_MS = 0.4 * HOUR_MS; // dev-fixtures.ts: a01 (THYAO) is published 0.4 h before "now"
  const ist = (hhmmss: string, day = DAY) => `${day}T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}+03:00`;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Builds a fresh fixture client with "now" pinned so that article `articleId` was published at `headlineIst`. */
  async function fixtureWith(articleId: string, agoMs: number, headlineIst: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(headlineIst) + agoMs);
    const client = createFinanceFakeClient() as Reader;
    const feed = await client.rpc("econ_feed", { p_limit: 80 });
    const published = (feed.data ?? []).find((a) => a.id === articleId)?.published_at;
    expect(published, `harness: ${articleId} must be published at ${headlineIst}`).toBe(new Date(headlineIst).toISOString());
    const bars = (await (client.from("bist_bars_5m").eq("ticker", "THYAO") as unknown as Promise<{ data: Bar[] | null }>)).data ?? [];
    const stats = (await (client.from("bist_quote_stats").eq("ticker", "THYAO") as unknown as Promise<{
      data: Array<{ ticker: string; last_day: string; last_close: number }> | null;
    }>)).data ?? [];
    const refPrice = async (id: string, ticker: string) => {
      const res = await client.rpc("feed_reference_prices", { p_article_ids: [id] });
      return (res.data ?? []).find((r) => r.ticker === ticker)?.ref_price as number | null | undefined;
    };
    /** Any ticker's own previous daily close (bist_quote_stats) and its newest bar close (today's settled close once the session is over). */
    const tickerRows = async (ticker: string) => {
      const tBars = ((await (client.from("bist_bars_5m").eq("ticker", ticker) as unknown as Promise<{ data: Bar[] | null }>)).data ?? []).filter(
        (b) => b.ticker === ticker,
      );
      const tStats = ((await (client.from("bist_quote_stats").eq("ticker", ticker) as unknown as Promise<{
        data: Array<{ ticker: string; last_close: number }> | null;
      }>)).data ?? []).filter((s) => s.ticker === ticker);
      return { prevClose: tStats[0]!.last_close, settled: tBars[tBars.length - 1]!.close };
    };
    return { bars, stats, refPrice, tickerRows };
  }

  /** THYAO's a01 headline at `headlineIst`: the fixture's reference price, its bars and its previous daily row. */
  async function thyaoAt(headlineIst: string) {
    const { bars, stats, refPrice } = await fixtureWith("a01", A01_AGO_MS, headlineIst);
    const barAt = (hhmm: string) => {
      const bar = bars.find((b) => b.ts === new Date(ist(hhmm)).toISOString());
      if (!bar) throw new Error(`the fixture has no THYAO bar stamped ${hhmm} Istanbul`);
      return bar;
    };
    // bist_quote_stats stands in for the previous session's daily row (last_day, last_close)
    const prev = stats.find((s) => s.ticker === "THYAO")!;
    expect(prev.last_day).toBe(PREV_DAY);
    return { bars, barAt, prevClose: prev.last_close, price: await refPrice("a01", "THYAO") };
  }

  it("the session opens with a volume-0 auction stub at 09:55 (start-stamped), the first trades at 10:00", async () => {
    const { bars, barAt, prevClose } = await thyaoAt(ist("12:00:00"));
    const stub = barAt("09:55");
    expect(bars[0]).toBe(stub);
    expect(stub.volume).toBe(0);
    expect(barAt("10:00").volume).toBeGreaterThan(0);
    // the auction price is its own number, not the previous close and not the 10:00 close
    expect(stub.close).not.toBe(prevClose);
    expect(stub.close).not.toBe(barAt("10:00").close);
  });

  it("edge 10:02 takes the 09:55 stub close (the 10:00 bar is still running; the old rule took it)", async () => {
    const { barAt, price } = await thyaoAt(ist("10:02:00"));
    expect(price).toBe(barAt("09:55").close);
    expect(price).not.toBe(barAt("10:00").close);
  });

  it("edge 09:58 takes the previous daily close: the only bar of today is the running 09:55 stub", async () => {
    const { barAt, prevClose, price } = await thyaoAt(ist("09:58:00"));
    expect(price).toBe(prevClose);
    expect(price).not.toBe(barAt("09:55").close); // the old rule took the stub
  });

  it("edge 18:03 takes the 17:55 close (the 18:00 bar is still running; the reference day is still yesterday)", async () => {
    const { barAt, price } = await thyaoAt(ist("18:03:00"));
    expect(price).toBe(barAt("17:55").close);
    expect(price).not.toBe(barAt("18:00").close); // the old rule took it
  });

  it("edge 18:12 takes today's daily close: the settled close beats the completed 18:05 bar (187's rule, kept)", async () => {
    const { bars, barAt, price } = await thyaoAt(ist("18:12:00"));
    // the fixture's daily row for today lands when the session ends (18:10) and is the session's last bar close
    const settled = bars[bars.length - 1]!.close;
    expect(bars[bars.length - 1]!.ts).toBe(new Date(ist("18:10")).toISOString());
    expect(price).toBe(settled);
    expect(price).not.toBe(barAt("18:05").close); // what a bare five-minute shift would return
  });

  it("edge 12:00:00 takes the 11:55 close, not the 12:00 bar that contains the headline", async () => {
    const { barAt, price } = await thyaoAt(ist("12:00:00"));
    expect(price).toBe(barAt("11:55").close);
    expect(price).not.toBe(barAt("12:00").close); // the old rule took it
  });

  it("a bar is used from ts + 5 min exactly, inclusive, to the second", async () => {
    const cases: Array<[string, string]> = [
      ["11:59:59", "11:50"],
      ["12:00:00", "11:55"],
      ["12:04:59", "11:55"],
      ["12:05:00", "12:00"],
      ["10:04:59", "09:55"],
      ["10:05:00", "10:00"],
    ];
    for (const [headline, bar] of cases) {
      const { barAt, price } = await thyaoAt(ist(headline));
      expect(price, `${headline} should read the ${bar} bar`).toBe(barAt(bar).close);
    }
  });

  it("the daily row of today is not the reference until 18:10: 18:09:59 reads the 18:00 bar, 18:10:00 the settled close", async () => {
    const before = await thyaoAt(ist("18:09:59"));
    expect(before.price).toBe(before.barAt("18:00").close);
    const at = await thyaoAt(ist("18:10:00"));
    expect(at.price).toBe(at.bars[at.bars.length - 1]!.close);
    expect(at.price).not.toBe(at.barAt("18:05").close);
  });

  it("a headline from before the previous session still reads the previous close (the fixture keeps one daily row)", async () => {
    // a19: THYAO, published 33 h before "now"; pin "now" at noon so the headline is Tuesday 03:00, before any bar
    const { stats, refPrice } = await fixtureWith("a19", 33 * HOUR_MS, ist("03:00:00", PREV_DAY));
    expect(await refPrice("a19", "THYAO")).toBe(stats.find((s) => s.ticker === "THYAO")!.last_close);
  });

  // The reference day is the Istanbul date of the headline itself. The fixture's daily rows are the previous
  // close (day(1)) and, from 18:10 on, today's settled close (day(0)); a headline from the previous evening that
  // is read after today's session has ended must pick the previous row, even from 21:00 on (UTC+3 must be added
  // once, not twice).
  it("a headline from 21:00-23:59 Istanbul the previous evening reads that day's close, not today's settled close", async () => {
    // a16 (EREGL) 23:00 the previous evening; "now" = 2026-11-12 19:00 Istanbul, after today's session
    const late = await fixtureWith("a16", 20 * HOUR_MS, ist("23:00:00", DAY));
    const eregl = await late.tickerRows("EREGL");
    expect(eregl.settled, "harness: today's settled close must differ from the previous close").not.toBe(eregl.prevClose);
    const lateRef = await late.refPrice("a16", "EREGL");
    expect(lateRef).toBe(eregl.prevClose);
    expect(lateRef).not.toBe(eregl.settled);
  });

  it("the 21:00:00 Istanbul boundary of the previous evening reads that day's close, not today's settled close", async () => {
    // a17 (BIMAS) at exactly 21:00; "now" = 2026-11-12 23:00 Istanbul
    const edge = await fixtureWith("a17", 26 * HOUR_MS, ist("21:00:00", DAY));
    const bimas = await edge.tickerRows("BIMAS");
    expect(bimas.settled).not.toBe(bimas.prevClose);
    const edgeRef = await edge.refPrice("a17", "BIMAS");
    expect(edgeRef).toBe(bimas.prevClose);
    expect(edgeRef).not.toBe(bimas.settled);
  });

  it("control: a headline at 20:59 Istanbul the previous evening reads that day's close as well", async () => {
    const { tickerRows, refPrice } = await fixtureWith("a17", 26 * HOUR_MS, ist("20:59:00", DAY));
    const bimas = await tickerRows("BIMAS");
    expect(bimas.settled).not.toBe(bimas.prevClose);
    const ref = await refPrice("a17", "BIMAS");
    expect(ref).toBe(bimas.prevClose);
    expect(ref).not.toBe(bimas.settled);
  });
});
