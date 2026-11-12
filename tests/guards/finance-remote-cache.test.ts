import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (perf, h21-perf-2): the public finance readers cache in
// the REMOTE handler, not in the per-instance memory.
//
// A plain `"use cache"` entry lives in one function instance's memory. /ekonomi
// renders its data inside a post-connection() dynamic hole, so every request
// that lands on a different (or cold) instance re-ran the PostgREST reads
// (rpc/econ_feed, kap_disclosures, bist_quote_stats, feed_reference_prices)
// and the Yahoo quote fetches, inside a FEED_CACHE window that was meant to
// absorb them. Three GETs two to three seconds apart produced two econ_feed
// calls, and the Yahoo 404 for DENIZ/DNZ/FNCLL/KILER was re-fetched each time.
// `"use cache: remote"` shares the entry across instances (the cluster readers
// already use it).
//
// The body shape does not change: `cacheTag`, then `attemptCached` (never
// rejects, so nothing throws across the remote boundary), then exactly one
// `cacheLife`, with `resolveCachedOrThrow` outside. cache-life-literal,
// cache-life-after-attempt and cache-retry-prerender keep pinning that shape.
//
// What this file enforces: every function-level cache directive in
// src/lib/finance/queries.ts, quotes.ts and traded-tickers.ts, mapped to the
// nearest preceding `async function <name>`, is `"use cache: remote"` --
// except the ADMIN allow-list below -- and a directive on a function that is
// in neither list fails, so a new reader must be classified on purpose.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const FINANCE_DIR = join(resolve(here, "../.."), "src", "lib", "finance");

const DIRECTIVE_LINE = /^\s*["']use cache(:[^"']*)?["'];?\s*$/;
const FUNCTION_LINE = /\basync\s+function\s+([A-Za-z_$][\w$]*)/;

interface Directive {
  fn: string;
  /** The directive exactly as written, e.g. "use cache: remote". */
  directive: string;
  line: number;
}

/** Function-level cache directives, each mapped to the nearest preceding async function. */
function directives(src: string): Directive[] {
  const out: Directive[] = [];
  let fn = "<none>";
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fnMatch = FUNCTION_LINE.exec(line);
    if (fnMatch && !DIRECTIVE_LINE.test(line)) fn = fnMatch[1] ?? fn;
    const dir = DIRECTIVE_LINE.exec(line);
    if (dir) {
      const text = line.trim().replace(/;$/, "");
      out.push({ fn, directive: text.slice(1, -1), line: i + 1 });
    }
  }
  return out;
}

const REMOTE = "use cache: remote";
const INSTANCE = "use cache";

/** queries.ts readers behind the public /ekonomi pages: shared across instances. */
const PUBLIC_REMOTE = [
  "fetchEconFeedCached",
  "fetchTopTickersCached",
  "fetchRecentDisclosuresCached",
  "fetchCircuitBreakersCached",
  "fetchQuoteStatsCached",
  "fetchReferencePricesCached",
  "fetchIntradayCached",
  "fetchTickerPageCached",
] as const;

/**
 * Admin-only readers. They serve /admin/ekonomi alone, under ADMIN_CACHE
 * (a short 300 s expiry), behind requireAdminSession(): a handful of
 * operator requests per hour does not justify a remote round trip, so they
 * stay instance-local. Moving one to a public page means moving it to the
 * list above.
 */
const ADMIN_INSTANCE_LOCAL = [
  "fetchFinanceHealthCached",
  "fetchSignalsCached",
  "fetchLagHistogramCached",
] as const;

const queries = directives(readFileSync(join(FINANCE_DIR, "queries.ts"), "utf-8"));
const quotes = directives(readFileSync(join(FINANCE_DIR, "quotes.ts"), "utf-8"));
const traded = directives(readFileSync(join(FINANCE_DIR, "traded-tickers.ts"), "utf-8"));

const names = (list: readonly Directive[]): string[] => list.map((d) => d.fn).sort();

describe("finance remote cache (h21-perf-2)", () => {
  it("queries.ts has exactly 11 function-level cache directives (the guard is not vacuous)", () => {
    expect(queries).toHaveLength(11);
    expect(names(queries)).toEqual([...PUBLIC_REMOTE, ...ADMIN_INSTANCE_LOCAL].sort());
  });

  it.each(PUBLIC_REMOTE)('%s is "use cache: remote"', (fn) => {
    const found = queries.filter((d) => d.fn === fn);
    expect(found).toHaveLength(1);
    expect(found[0]?.directive).toBe(REMOTE);
  });

  it.each(ADMIN_INSTANCE_LOCAL)('%s (admin-only, ADMIN_CACHE) stays "use cache"', (fn) => {
    const found = queries.filter((d) => d.fn === fn);
    expect(found).toHaveLength(1);
    expect(found[0]?.directive).toBe(INSTANCE);
  });

  it('quotes.ts getQuote is "use cache: remote" and is the only directive there', () => {
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.fn).toBe("getQuote");
    expect(quotes[0]?.directive).toBe(REMOTE);
  });

  it('traded-tickers.ts getTradedTickersCached (home search ticker set) is "use cache: remote" and is the only directive there', () => {
    expect(traded).toHaveLength(1);
    expect(traded[0]?.fn).toBe("getTradedTickersCached");
    expect(traded[0]?.directive).toBe(REMOTE);
  });

  it("fails any directive that is in neither list", () => {
    const known = new Set<string>([
      ...PUBLIC_REMOTE,
      ...ADMIN_INSTANCE_LOCAL,
      "getQuote",
      "getTradedTickersCached",
    ]);
    const unclassified = [...queries, ...quotes, ...traded].filter((d) => !known.has(d.fn));
    expect(unclassified.map((d) => `${d.fn}:${d.line}`)).toEqual([]);
  });
});

describe("finance remote cache guard self-check", () => {
  it("maps each directive to the nearest preceding async function", () => {
    const src = `async function a() {\n  "use cache";\n}\nexport async function b(x: number) {\n  'use cache: remote';\n}\n`;
    expect(directives(src)).toEqual([
      { fn: "a", directive: "use cache", line: 2 },
      { fn: "b", directive: "use cache: remote", line: 5 },
    ]);
  });

  it("matches the directive forms Next accepts, and ignores prose mentions", () => {
    expect(DIRECTIVE_LINE.test('  "use cache";')).toBe(true);
    expect(DIRECTIVE_LINE.test("  'use cache: remote'")).toBe(true);
    expect(DIRECTIVE_LINE.test('  "use cache: private";')).toBe(true);
    expect(DIRECTIVE_LINE.test(' * Deliberately NOT "use cache" -- the admin operator')).toBe(false);
    expect(DIRECTIVE_LINE.test('// a `"use cache"` body fails next build')).toBe(false);
  });
});
