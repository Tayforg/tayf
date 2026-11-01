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
