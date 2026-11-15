import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h192-a11y-2): no <aside> inside <main> on the home page.
//
// The "Yükselen konular" rail and the "Günün Tayf'ı" teaser were <aside> blocks in the middle of the feed, which is inside
// <main>. A complementary landmark belongs at the top level of the page (axe landmark-complementary-is-top-level): landmark
// navigation listed two nested "complementary" regions between the story sections. Both are now named <section> regions (the
// rail names itself through its h2, the teaser through aria-label); they keep their place in <main>. Server components are not
// render-tested in this repo, so this reads the sources (comments blanked, offsets kept, as in tests/guards/heading-outline.test.ts).
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

describe("home landmarks: no <aside> inside <main> (h192-a11y-2)", () => {
  const page = read("src/app/page.tsx");
  const rail = read("src/components/home/rising-rail.tsx");

  it("neither the home page nor the rising rail opens or closes an <aside>", () => {
    for (const [name, src] of [
      ["src/app/page.tsx", page],
      ["src/components/home/rising-rail.tsx", rail],
    ] as const) {
      expect(src, name).not.toMatch(/<\/?aside\b/);
    }
  });

  it("the rail is one <section> named by its own h2 (aria-labelledby points at the h2's id)", () => {
    expect(count(rail, "<section")).toBe(1);
    expect(count(rail, "</section>")).toBe(1);
    expect(rail).toMatch(/<section aria-labelledby="yukselen-konular-baslik" className="space-y-3">/);
    expect(rail).toMatch(/<h2 id="yukselen-konular-baslik"/);
    expect(count(rail, "yukselen-konular-baslik")).toBe(2);
    // The heading names the region; a second name beside it would be read twice.
    expect(rail).not.toContain('aria-label="Yükselen konular"');
  });

  it("the teaser is one <section aria-label> around DailyGameTeaser, in the same place as before", () => {
    const at = page.indexOf(`<section aria-label="Günün Tayf'ı">`);
    expect(at).toBeGreaterThan(-1);
    expect(count(page, `aria-label="Günün Tayf'ı"`)).toBe(1);
    const close = page.indexOf("</section>", at);
    expect(close).toBeGreaterThan(at);
    const inside = page.slice(at, close);
    expect(inside).toContain("<DailyGameTeaser puzzleNumber={teaserSlot.puzzleNumber} />");
    // It is the `teaser` that the feed places right after the first story section, still inside <main>'s feed.
    expect(page).toMatch(/const teaser = teaserSlot \? \(\s*<section aria-label="Günün Tayf'ı">/);
    expect(count(page, "{breaking.length > 0 && teaser}")).toBe(1);
    expect(count(page, "{breaking.length === 0 && bucketIdx === 0 && teaser}")).toBe(1);
  });
});
