import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 79, h79-cachecoherence-1): every public surface that
// shows a cluster's counts or its "Kör nokta" ribbon to a crawler or an embedding
// page bounds how old a CDN copy it can hand out.
//
//   (a) The 200-path Cache-Control literal of the cluster share card
//       (opengraph-image.tsx, OG_CACHE_HEADERS), the rozet badge
//       (rozet/[file]/route.ts, OK_HEADERS), the embed
//       (embed/cluster/[id]/route.ts, OK_HEADERS) and the kart card
//       (cluster/[id]/kart/route.tsx) carries both s-maxage and
//       stale-while-revalidate, and the two add up to at most 900 s. The share
//       card and the badge carried stale-while-revalidate=86400: nothing purges
//       an image CDN entry when a cluster changes, so a copy older than its own
//       s-maxage was handed to a crawler once more (live: STALE, age 1109, the
//       old 11-source card) and the platform then froze it in its own unfurl
//       cache.
//   (b) twitter-image.tsx still re-exports the default export of
//       ./opengraph-image, so the X card inherits the same policy and cannot drift.
//   (c) docs/api.md has a section naming /cluster/{id}/opengraph-image and
//       /rozet/{id}.svg that quotes the Cache-Control the code sends, plus the
//       not-found and read-failure rows, and docs/architecture.md states the
//       15-minute bound.
//
// Source guard only: the route files cannot export extra names (the rozet and
// embed routes) or carry the header outside an options object (kart), so their
// text is parsed instead of importing a constant. Every number is read from the
// code, so a later change to a header fails here until the docs follow.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const read = (...parts: string[]): string => readFileSync(resolve(ROOT, ...parts), "utf8");

const OG = read("src", "app", "cluster", "[id]", "opengraph-image.tsx");
const TWITTER = read("src", "app", "cluster", "[id]", "twitter-image.tsx");
const ROZET = read("src", "app", "rozet", "[file]", "route.ts");
const EMBED = read("src", "app", "embed", "cluster", "[id]", "route.ts");
const KART = read("src", "app", "cluster", "[id]", "kart", "route.tsx");
const API_DOC = read("docs", "api.md");
const ARCH_DOC = read("docs", "architecture.md");

/** The window a CDN copy can be served for: s-maxage plus stale-while-revalidate, in seconds. */
const MAX_WINDOW_SECONDS = 900;

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

/** Every `cache-control` value (either key casing) written as a string literal inside `text`. */
function cacheControlLiterals(text: string): string[] {
  return [...text.matchAll(/["']cache-control["']\s*:\s*["']([^"']*)["']/gi)].map((m) => m[1] as string);
}

/** The text of `const NAME = { ... }` (the object literal only); "" when the const is missing. */
function objectConst(source: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{([^}]*)\\}`).exec(source);
  return m ? (m[1] as string) : "";
}

function directive(value: string, name: string): number | null {
  const m = new RegExp(`(?:^|,\\s*)${name}=(\\d+)(?:,|$)`).exec(value);
  return m ? Number(m[1]) : null;
}

/** The one cache-control literal found in `text`, or "" when there is none or more than one. */
function only(literals: string[]): string {
  return literals.length === 1 ? (literals[0] as string) : "";
}

const SURFACES = [
  { name: "cluster share card (OG_CACHE_HEADERS)", literals: cacheControlLiterals(objectConst(OG, "OG_CACHE_HEADERS")) },
  { name: "rozet badge (OK_HEADERS)", literals: cacheControlLiterals(objectConst(ROZET, "OK_HEADERS")) },
  { name: "embed (OK_HEADERS)", literals: cacheControlLiterals(objectConst(EMBED, "OK_HEADERS")) },
  // kart sets the header inline on its one ImageResponse; the 404 path sets none.
  { name: "kart card (ImageResponse headers)", literals: cacheControlLiterals(KART).filter((v) => v.includes("s-maxage")) },
] as const;

const OG_LITERAL = only(SURFACES[0].literals);
const ROZET_LITERAL = only(SURFACES[1].literals);
const OG_NOT_FOUND_LITERAL = only(cacheControlLiterals(objectConst(OG, "OG_NOT_FOUND_HEADERS")));
const OG_UNAVAILABLE_LITERAL = only(cacheControlLiterals(objectConst(OG, "OG_UNAVAILABLE_CACHE_HEADERS")));

const SHARE_DOC = section(API_DOC, "### `GET /cluster/{id}/opengraph-image`, `/cluster/{id}/twitter-image` and `/rozet/{id}.svg`");

describe("share-surface cache window (h79-cachecoherence-1)", () => {
  describe("(a) the 200-path Cache-Control is bounded", () => {
    for (const surface of SURFACES) {
      describe(surface.name, () => {
        const literal = only(surface.literals);
        const sMaxage = directive(literal, "s-maxage");
        const swr = directive(literal, "stale-while-revalidate");

        it("has exactly one public literal with both s-maxage and stale-while-revalidate", () => {
          expect(surface.literals).toHaveLength(1);
          expect(literal).toMatch(/^public, /);
          expect(sMaxage).not.toBeNull();
          expect(swr).not.toBeNull();
        });

        it(`serves a copy for at most ${MAX_WINDOW_SECONDS} s (s-maxage + stale-while-revalidate)`, () => {
          expect((sMaxage as number) + (swr as number)).toBeLessThanOrEqual(MAX_WINDOW_SECONDS);
        });
      });
    }

    it("the share card and the rozet badge use the same policy", () => {
      expect(OG_LITERAL).not.toBe("");
      expect(ROZET_LITERAL).toBe(OG_LITERAL);
    });
  });

  describe("(b) the twitter card inherits the share-card policy", () => {
    it("twitter-image.tsx re-exports the default export of ./opengraph-image", () => {
      expect(TWITTER).toMatch(/export\s*\{[^}]*\bdefault\b[^}]*\}\s*from\s*["']\.\/opengraph-image["']/);
    });

    it("twitter-image.tsx declares no cache-control of its own", () => {
      expect(cacheControlLiterals(TWITTER)).toEqual([]);
    });
  });

  describe("(c) the docs state the window", () => {
    it("docs/api.md has the share-surface section and the not-found / read-failure literals are found in the code", () => {
      expect(SHARE_DOC).not.toBe("");
      expect(OG_NOT_FOUND_LITERAL).toMatch(/^public, s-maxage=\d+$/);
      expect(OG_UNAVAILABLE_LITERAL).toBe("no-store");
    });

    it("the section names both surfaces", () => {
      expect(SHARE_DOC).toContain("/cluster/{id}/opengraph-image");
      expect(SHARE_DOC).toContain("/cluster/{id}/twitter-image");
      expect(SHARE_DOC).toContain("/rozet/{id}.svg");
    });

    it("the section quotes the Cache-Control the share card and the rozet badge send", () => {
      expect(OG_LITERAL).not.toBe("");
      expect(SHARE_DOC).toContain(`\`${OG_LITERAL}\``);
      expect(SHARE_DOC).toContain(`\`${ROZET_LITERAL}\``);
    });

    it("the section quotes the not-found and read-failure Cache-Control too", () => {
      expect(SHARE_DOC).toContain(`\`${OG_NOT_FOUND_LITERAL}\``);
      expect(SHARE_DOC).toContain(`\`${OG_UNAVAILABLE_LITERAL}\``);
    });

    it("the section quotes no stale-while-revalidate other than the code's", () => {
      const swr = directive(OG_LITERAL, "stale-while-revalidate");
      const quoted = [...SHARE_DOC.matchAll(/stale-while-revalidate=(\d+)/g)].map((m) => Number(m[1]));
      expect(quoted.length).toBeGreaterThan(0);
      for (const seconds of quoted) expect(seconds).toBe(swr);
    });

    it("the section says the data inside a card can lag by the cluster-feed window", () => {
      // The 900 s bound is on the CDN copy only; the counts inside a render come from the
      // cluster detail cache (cacheLife "cluster-feed"), so the doc must name that window too.
      // includes() rather than toContain(): a failing toContain prints the whole section.
      expect(SHARE_DOC.includes("cluster-feed")).toBe(true);
    });

    it("docs/architecture.md states the 15-minute CDN bound and names this guard", () => {
      // includes() rather than toContain(): a failing toContain prints the whole document.
      expect(ARCH_DOC.includes("at most 900 s")).toBe(true);
      expect(ARCH_DOC.includes("tests/guards/share-surface-cache-window.test.ts")).toBe(true);
    });
  });
});
