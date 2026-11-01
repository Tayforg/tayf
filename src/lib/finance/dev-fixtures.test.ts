import { describe, expect, it, vi } from "vitest";
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
