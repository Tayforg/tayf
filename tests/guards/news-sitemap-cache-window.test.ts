import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 126, h126-freshness-1): /sitemaps/news.xml, the file
// Google News reads, bounds how old a copy a crawler can be handed, and
// docs/architecture.md says so. Same mechanism as tests/guards/rss-cache-window
// (h75-freshness-1), applied to the one sitemap with measured evidence.
//
//   (a) The route's NEWS_CACHE_HEADERS literal has s-maxage <= 300 and
//       stale-while-revalidate <= 60, so the CDN never serves a copy more than
//       360 s after it was built. It carried stale-while-revalidate=3600: after
//       600 s every expired copy was served once more, up to 70 min old, before
//       the background rebuild, so a crawler polling less often than every
//       10 min was always handed the list built at its previous poll (live:
//       STALE, age 2831, 4 eligible stories missing). Bounding the CDN layer
//       does not bound the use-cache entry behind it (getNewsSitemapXmlCached,
//       revalidate 600); that window is deliberately left as it is.
//   (b) docs/architecture.md quotes the same Cache-Control literal on a line
//       that names news.xml, so a later change to the header fails here until
//       the docs follow.
//
// The other leaf files (static, sources, hubs, closed and open months) keep
// their own, longer headers on purpose; this guard reads NEWS_CACHE_HEADERS
// only. Source guard only: the route file cannot export extra names, so its
// text is parsed instead of importing the constant.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const ROUTE = readFileSync(resolve(ROOT, "src", "app", "sitemaps", "[file]", "route.ts"), "utf8");
const DOC = readFileSync(resolve(ROOT, "docs", "architecture.md"), "utf8");

/** Every `const NEWS_CACHE_HEADERS = { "Cache-Control": "<literal>" }` value in the route. */
function newsCacheControl(source: string): string[] {
  return [
    ...source.matchAll(/const\s+NEWS_CACHE_HEADERS\s*=\s*\{\s*"Cache-Control":\s*"([^"]*)"\s*,?\s*\}/g),
  ].map((m) => m[1] as string);
}

function directive(value: string, name: string): number | null {
  const m = new RegExp(`(?:^|,\\s*)${name}=(\\d+)(?:,|$)`).exec(value);
  return m ? Number(m[1]) : null;
}

const LITERALS = newsCacheControl(ROUTE);
const LITERAL = LITERALS[0] ?? "";
const S_MAXAGE = directive(LITERAL, "s-maxage");
const SWR = directive(LITERAL, "stale-while-revalidate");

/** Doc lines that name the news sitemap file. */
const NEWS_DOC_LINES = DOC.split("\n").filter((l) => l.includes("news.xml"));

describe("/sitemaps/news.xml cache window (h126-freshness-1)", () => {
  it("finds exactly one NEWS_CACHE_HEADERS literal, both directives, and a docs line for news.xml", () => {
    expect(LITERALS).toHaveLength(1);
    expect(LITERAL).toMatch(/^public, /);
    expect(S_MAXAGE).not.toBeNull();
    expect(SWR).not.toBeNull();
    expect(NEWS_DOC_LINES.length).toBeGreaterThan(0);
  });

  it("(a) s-maxage is at most 300 s", () => {
    expect(S_MAXAGE as number).toBeLessThanOrEqual(300);
  });

  it("(a) stale-while-revalidate is at most 60 s", () => {
    expect(SWR as number).toBeLessThanOrEqual(60);
  });

  it("(a) the CDN never serves a copy more than 360 s after it was built", () => {
    expect((S_MAXAGE as number) + (SWR as number)).toBeLessThanOrEqual(360);
  });

  it("(b) docs/architecture.md quotes the Cache-Control the news sitemap sends, on a line naming news.xml", () => {
    expect(NEWS_DOC_LINES.some((l) => l.includes(`Cache-Control: ${LITERAL}`))).toBe(true);
  });

  it("(b) every stale-while-revalidate quoted on a news.xml docs line is the route's SWR seconds", () => {
    const quoted = NEWS_DOC_LINES.flatMap((l) =>
      [...l.matchAll(/stale-while-revalidate=(\d+)/g)].map((m) => Number(m[1])),
    );
    // The index bullet that merely lists news.xml quotes no header; the bullet that does must agree.
    expect(quoted.length).toBeGreaterThan(0);
    for (const seconds of quoted) expect(seconds).toBe(SWR);
  });
});
