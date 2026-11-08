import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 75, h75-freshness-1): /rss.xml bounds how old a copy
// a feed reader can be handed, and docs/api.md says so.
//
//   (a) The route's Cache-Control literal has s-maxage <= 300 and
//       stale-while-revalidate <= 60, so the CDN never serves a copy more than
//       360 s after it was built. It carried
//       stale-while-revalidate=3600: every expired copy was served once more
//       before the background rebuild, so a reader polling every P minutes
//       (5 < P < 65) always received a feed about P minutes old (live: STALE,
//       age 834, 7 of 30 items one source short). getPoliticsClusters is itself a
//       'use cache: remote' entry now, so the CDN SWR layer stacked up to an hour
//       of its own staleness on top of that entry's (cluster-feed: revalidate 300,
//       expire 3600); bounding the CDN layer removes the stacked hour but does not
//       bound the age of the data itself.
//   (b) The "### `GET /rss.xml`" section of docs/api.md quotes the same header
//       and the same SWR seconds the route sends, and the topic-feed Cache
//       bullet (which compares itself to /rss.xml) does not say there is no SWR.
//
// Source guard only: the route file cannot export extra names, so its text is
// parsed instead of importing a constant. Every number is read from the code, so
// a later change to the header fails here until the docs follow.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const ROUTE = readFileSync(resolve(ROOT, "src", "app", "rss.xml", "route.ts"), "utf8");
const DOC = readFileSync(resolve(ROOT, "docs", "api.md"), "utf8");

/** The text from the first line equal to `heading` up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return "";
  const level = heading.length - heading.trimStart().replace(/^#+/, "").length;
  const out: string[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (!inFence) {
      let hashes = 0;
      while (line[hashes] === "#") hashes++;
      if (hashes > 0 && hashes <= level && line[hashes] === " ") break;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** The success-path Cache-Control literal: the one that is public (the 503 path is no-store, in the builder). */
function successCacheControl(source: string): string[] {
  return [...source.matchAll(/"Cache-Control":\s*"([^"]*)"/g)]
    .map((m) => m[1] as string)
    .filter((v) => v.includes("s-maxage"));
}

function directive(value: string, name: string): number | null {
  const m = new RegExp(`(?:^|,\\s*)${name}=(\\d+)(?:,|$)`).exec(value);
  return m ? Number(m[1]) : null;
}

const LITERALS = successCacheControl(ROUTE);
const LITERAL = LITERALS[0] ?? "";
const S_MAXAGE = directive(LITERAL, "s-maxage");
const SWR = directive(LITERAL, "stale-while-revalidate");

const RSS_DOC = section(DOC, "### `GET /rss.xml`");
const FEEDS_DOC = section(DOC, "### Topic and blindspot RSS feeds");
const TOPIC_CACHE_BULLET = FEEDS_DOC.split("\n").find((l) => l.startsWith("- **Cache**")) ?? "";

describe("/rss.xml cache window (h75-freshness-1)", () => {
  it("finds exactly one success Cache-Control literal, both directives, and the docs sections", () => {
    expect(LITERALS).toHaveLength(1);
    expect(LITERAL).toMatch(/^public, /);
    expect(S_MAXAGE).not.toBeNull();
    expect(SWR).not.toBeNull();
    expect(RSS_DOC).not.toBe("");
    expect(FEEDS_DOC).not.toBe("");
    expect(TOPIC_CACHE_BULLET).not.toBe("");
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

  it("(b) the /rss.xml docs section quotes the Cache-Control the route sends", () => {
    expect(RSS_DOC).toContain(`Cache-Control: ${LITERAL}`);
  });

  it("(b) the /rss.xml docs section states the same SWR seconds as the route and no other", () => {
    expect(RSS_DOC).toContain(`stale-while-revalidate=${SWR}`);
    expect(RSS_DOC).toContain(`${SWR} seconds`);
    const quoted = [...RSS_DOC.matchAll(/stale-while-revalidate=(\d+)/g)].map((m) => Number(m[1]));
    expect(quoted.length).toBeGreaterThan(0);
    for (const seconds of quoted) expect(seconds).toBe(SWR);
  });

  it("(b) the /rss.xml docs section bounds only the CDN copy and names the cluster-feed cache behind it", () => {
    expect(RSS_DOC).not.toMatch(/never gets a copy older/);
    expect(RSS_DOC).not.toContain("at most once more");
    expect(RSS_DOC).toContain("cluster-feed");
  });

  it("(b) the topic-feed Cache bullet says /rss.xml adds the same SWR, not that it has none", () => {
    expect(TOPIC_CACHE_BULLET).not.toContain("there is no `stale-while-revalidate`");
    expect(TOPIC_CACHE_BULLET).toContain(`/rss.xml\` adds a ${SWR}-second \`stale-while-revalidate\``);
  });
});
