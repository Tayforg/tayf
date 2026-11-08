import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h67-landmarks-1): the heading outline of the two card
// feeds. Home and /blindspots rendered every story headline as an <h2>, level
// with the section labels above them ("Son Dakika", "Bugün", "Dün"), so heading
// navigation could not tell a group from a story. The outline is now h1 page,
// h2 section, h3 story. Server components are not render-tested in this repo,
// so this reads the sources: ClusterCard takes `headingLevel` and both feeds
// pass 3, and every card on them sits under an h2.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

/** Blanks // and block comments, keeping offsets (no `//` inside strings in these files except `https://`). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function read(rel: string): string {
  return blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The `<ClusterCard ... />` element starting at `from`: the opening tag, walked
 * to the first `>` outside braces and string literals, so a `>` in a prop value
 * (`hoursAgo > 48`) does not end it early.
 */
function clusterCardTagAt(src: string, from: number): string {
  const start = src.indexOf("<ClusterCard", from);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let quote: string | null = null;
  let i = start + "<ClusterCard".length;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && depth > 0)) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  return src.slice(start, i + 1);
}

describe("home feed heading outline (h67-landmarks-1)", () => {
  const page = read("src/app/page.tsx");

  it("renders cards only through renderClusterCard, which passes headingLevel={3}", () => {
    expect(count(page, "<ClusterCard")).toBe(1);
    const fn = page.indexOf("function renderClusterCard(");
    expect(fn).toBeGreaterThan(-1);
    const tag = clusterCardTagAt(page, fn);
    expect(tag).toContain("headingLevel={3}");
  });

  it("calls renderClusterCard three times (Son Dakika, buckets, archive), each after an <h2> of its own <section>", () => {
    const calls = [...page.matchAll(/\brenderClusterCard\(b, /g)].map((m) => m.index!);
    expect(calls).toHaveLength(3);
    for (const at of calls) {
      const sectionAt = page.lastIndexOf("<section", at);
      expect(sectionAt).toBeGreaterThan(-1);
      const h2At = page.indexOf("<h2", sectionAt);
      expect(h2At).toBeGreaterThan(sectionAt);
      expect(h2At).toBeLessThan(at);
    }
  });

  it("holds no h3 or h4 of its own (the cards are the only level-3 headings)", () => {
    expect(page).not.toMatch(/<h[34][\s>]/);
  });
});

describe("/blindspots heading outline (h67-landmarks-1)", () => {
  const page = read("src/app/blindspots/page.tsx");

  it("renders cards through the one BlindspotCard, whose ClusterCard gets headingLevel={3}", () => {
    expect(count(page, "<ClusterCard")).toBe(1);
    const fn = page.indexOf("function BlindspotCard(");
    expect(fn).toBeGreaterThan(-1);
    const tag = clusterCardTagAt(page, fn);
    expect(tag).toContain("headingLevel={3}");
  });

  it("gives the card list a screen-reader-only h2 'Kör nokta haberleri', after the silence band and before the first card", () => {
    expect(count(page, 'Kör nokta haberleri')).toBe(1);
    expect(page).toContain('<h2 className="sr-only">Kör nokta haberleri</h2>');
    const band = page.indexOf("<SilenceDigestBand");
    const label = page.indexOf('<h2 className="sr-only">');
    const cards = page.indexOf("result.bundles.map(");
    expect(band).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(band);
    expect(cards).toBeGreaterThan(label);
  });

  it("keeps 'Diğer kör noktalar' an h2 and the compact rows free of cards and headings", () => {
    expect(page).toMatch(/<h2 id="diger-kor-noktalar"[^>]*>\s*Diğer kör noktalar\s*<\/h2>/);
    const more = page.slice(page.indexOf("function MoreBlindspotList("), page.indexOf("interface BlindspotCardProps"));
    expect(more).not.toContain("<ClusterCard");
    expect(more).not.toMatch(/<h3[\s>]/);
  });

  it("holds no h3 of its own: the cards are the only level-3 headings", () => {
    expect(page).not.toMatch(/<h3[\s>]/);
  });
});
