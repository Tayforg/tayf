import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Source guard + config pin for the /hafta weekly-words cache (h10-dbhot-3).
//
// pg_stat_statements (since 2026-09-28) showed the 21-read weekly-words fetch
// at ~645 calls/day, mean 1.45 s, max 8 s: a plain `"use cache"` is
// per-instance, so every serverless instance paid its own fill. The page
// shows a trailing-7-day comparison, so the words barely move intra-day. The
// reader now lives in the shared remote cache with a 6 h revalidate profile.
// No server render here: the guard reads the sources, like the other cache
// guards under tests/guards/.
// ---------------------------------------------------------------------------

const root = join(__dirname, "..", "..", "..");
const querySrc = readFileSync(join(__dirname, "distinctive-words-query.ts"), "utf8");
const configSrc = readFileSync(join(root, "next.config.ts"), "utf8");

/** Comments replaced by spaces (newlines kept); string literals untouched. */
function blankComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

const code = blankComments(querySrc);

/** The cached function, from its signature to the next column-0 `}` line. */
function cachedBody(): string {
  const start = code.indexOf("async function getCachedWeeklyDistinctiveWords()");
  expect(start, "getCachedWeeklyDistinctiveWords must exist").toBeGreaterThanOrEqual(0);
  const open = code.indexOf("{", start);
  const end = code.indexOf("\n}", open);
  expect(end).toBeGreaterThan(open);
  return code.slice(open + 1, end);
}

describe("weekly-words cached reader", () => {
  it('starts with the shared-cache directive "use cache: remote";', () => {
    const body = cachedBody();
    expect(body.trimStart().startsWith('"use cache: remote";')).toBe(true);
  });

  it('keeps no plain "use cache" directive anywhere in the module', () => {
    expect(code).not.toMatch(/["']use cache["']\s*;/);
    expect(code.match(/["']use cache: remote["']\s*;/g) ?? []).toHaveLength(1);
  });

  it("calls cacheLife exactly twice, with the literals 'weekly-words' then 'minutes'", () => {
    const literals = [...code.matchAll(/\bcacheLife\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
    expect(literals).toEqual(['"weekly-words"', '"minutes"']);
  });

  it("branches on the outcome instead of passing a conditional argument", () => {
    const body = cachedBody();
    expect(body).toMatch(/if\s*\(\s*r\.ok\s*\)\s*cacheLife\("weekly-words"\);\s*else\s+cacheLife\("minutes"\);/);
  });

  it("tags the entry before the attempt, and picks the lifetime after it", () => {
    const body = cachedBody();
    const tag = body.indexOf('cacheTag("weekly-words")');
    const attempt = body.indexOf("attemptCached(");
    const life = body.indexOf("cacheLife(");
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(attempt).toBeGreaterThan(tag);
    expect(life).toBeGreaterThan(attempt);
  });

  it("keeps attemptCached so nothing throws across the cache boundary", () => {
    expect(cachedBody()).toContain('attemptCached("weekly-words", fetchWeeklyDistinctiveWords)');
  });
});

// ---------------------------------------------------------------------------
// h14-perf-1: the 21 article reads (3 zones x 7 days) used to be one
// Promise.all(reads) fan-out: all 21 scans hit the database at once and a cold
// fill could pass the 4 s reader cap. They now go through a bounded pool. The
// pins read the code (comments blanked), so prose can never satisfy them.
// ---------------------------------------------------------------------------
describe("weekly-words article read fan-out", () => {
  it("bounds the pool with WEEKLY_WORDS_READ_CONCURRENCY = 4", () => {
    expect(code).toMatch(/\bWEEKLY_WORDS_READ_CONCURRENCY\s*=\s*4\b/);
    expect(code.match(/\bWEEKLY_WORDS_READ_CONCURRENCY\s*=/g) ?? []).toHaveLength(1);
  });

  it("runs the article reads through runWithConcurrency, never Promise.all(reads)", () => {
    expect(code).not.toMatch(/Promise\.all\(\s*reads\s*\)/);
    expect(code).toMatch(/runWithConcurrency\([^)]*WEEKLY_WORDS_READ_CONCURRENCY\s*\)/);
  });

  it("keeps the cache boundary intact: the pool lives in the uncached fetch, not in the cached body", () => {
    const body = cachedBody();
    expect(body).not.toContain("runWithConcurrency");
    expect(body).not.toContain("WEEKLY_WORDS_READ_CONCURRENCY");
  });

  it("does not add a dependency for the pool (no p-limit / p-map / async imports)", () => {
    expect(code).not.toMatch(/from\s+["'](?:p-limit|p-map|p-queue|async|bluebird)["']/);
  });
});

// ---------------------------------------------------------------------------
// h14-perf-1 (second step): the fill reads the precomputed public.weekly_words_sample
// table (migration 143) and pools the article reads only for days it lacks. The
// pins read the code (comments blanked) so prose can never satisfy them.
// ---------------------------------------------------------------------------
describe("weekly-words sample table read", () => {
  it("names the table and caps the paging at 8 requests", () => {
    expect(code).toMatch(/\bWEEKLY_WORDS_SAMPLE_TABLE\s*=\s*"weekly_words_sample"/);
    expect(code).toMatch(/\bWEEKLY_WORDS_SAMPLE_MAX_PAGES\s*=\s*8\b/);
    expect(code).toMatch(/\.from\(\s*WEEKLY_WORDS_SAMPLE_TABLE\s*\)/);
  });

  it("pages with readAllPages (the table can hold more than the 1,000-row PostgREST cap)", () => {
    expect(code).toMatch(/from\s+"@\/lib\/db\/paging"/);
    expect(code).toMatch(/\breadAllPages(?:<[^>]*>)?\(/);
    expect(code).toMatch(/maxPages:\s*WEEKLY_WORDS_SAMPLE_MAX_PAGES\b/);
    expect(code).toMatch(/\.range\(\s*from\s*,\s*to\s*\)/);
  });

  it("orders by the primary key (day, zone, article_id) so pages never skip or repeat a row", () => {
    const orders = [...code.matchAll(/\.order\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]);
    expect(orders).toEqual(["day", "zone", "article_id"]);
  });

  it("keeps the table read in the uncached fetch, never inside the cached body", () => {
    const body = cachedBody();
    expect(body).not.toContain("readAllPages");
    expect(body).not.toContain("WEEKLY_WORDS_SAMPLE_TABLE");
    expect(body).not.toContain("WEEKLY_WORDS_SAMPLE_MAX_PAGES");
    expect(body).not.toContain("istanbulDay");
    // ... and the uncached side of the module is where they live: the table read in its
    // helper, called (with the pooled fallback) from the uncached fetch.
    const fetchStart = code.indexOf("export async function fetchWeeklyDistinctiveWords()");
    const cachedStart = code.indexOf("async function getCachedWeeklyDistinctiveWords()");
    expect(fetchStart).toBeGreaterThanOrEqual(0);
    const uncached = code.slice(0, cachedStart);
    expect(uncached).toContain("readAllPages<");
    expect(uncached).toMatch(/\.from\(\s*WEEKLY_WORDS_SAMPLE_TABLE\s*\)/);
    const fetchBody = code.slice(fetchStart, cachedStart);
    expect(fetchBody).toContain("readSampleTable(");
    expect(fetchBody).toContain("istanbulDayKeys(");
    expect(fetchBody).toContain("runWithConcurrency(");
  });

  it("reads the clock once (one Date.now per fetch) and never in a helper", () => {
    expect(code.match(/\bDate\.now\(\)/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\bnew Date\(\s*\)/);
  });

  it("handles a missing table by code (PGRST205, 42P01), not by message text", () => {
    expect(code).toContain('"PGRST205"');
    expect(code).toContain('"42P01"');
    expect(code).toMatch(/console\.warn\(/);
  });

  it("does not import the trends module for the day keys (Turkiye is fixed UTC+3 since 2016)", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/trends/);
    expect(code).not.toMatch(/from\s+["']\.\.\/trends/);
  });

  it("has no .limit(N) above PostgREST's 1,000-row cap (the table is paged with .range)", () => {
    const consts = new Map<string, number>();
    for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(\d[\d_]*)\s*;/g)) {
      consts.set(m[1]!, Number(m[2]!.replace(/_/g, "")));
    }
    const limits = [...code.matchAll(/\.limit\(\s*([^()]*?)\s*\)/g)].map((m) => m[1]!);
    expect(limits.length).toBeGreaterThan(0);
    for (const arg of limits) {
      const value = /^\d[\d_]*$/.test(arg) ? Number(arg.replace(/_/g, "")) : consts.get(arg);
      expect(value, `.limit(${arg}) must resolve to a number in this file`).toBeDefined();
      expect(value!).toBeLessThanOrEqual(1000);
    }
  });
});

describe("next.config.ts cacheLife 'weekly-words' profile", () => {
  function profile(name: string): { stale: number; revalidate: number; expire: number } {
    const m = new RegExp(`['"]${name}['"]\\s*:\\s*\\{([^}]*)\\}`).exec(blankComments(configSrc));
    expect(m, `cacheLife profile '${name}' must be defined in next.config.ts`).toBeTruthy();
    const num = (key: string) => {
      const k = new RegExp(`${key}\\s*:\\s*(\\d+)`).exec(m![1]!);
      expect(k, `${name}.${key}`).toBeTruthy();
      return Number(k![1]);
    };
    return { stale: num("stale"), revalidate: num("revalidate"), expire: num("expire") };
  }

  it("is { stale: 3600, revalidate: 21600, expire: 86400 } (6 h revalidate)", () => {
    expect(profile("weekly-words")).toEqual({ stale: 3600, revalidate: 21600, expire: 86400 });
  });

  it("orders stale <= revalidate <= expire", () => {
    const p = profile("weekly-words");
    expect(p.stale).toBeLessThanOrEqual(p.revalidate);
    expect(p.revalidate).toBeLessThanOrEqual(p.expire);
  });
});
