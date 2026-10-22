import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source guard (repo convention: no render tests of server components --
// ClusterCard is an async-data Server Component). Pins the image-priority
// wiring the browser-6 fix depends on, so a refactor cannot quietly bring
// back a second eager/preloaded hero on every priority card.

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "cluster-card.tsx"), "utf8");

// Blanks line and block comments (offsets kept) so prose can't satisfy or trip a pattern.
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

const src = blankComments(raw);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("cluster-card.tsx image priority wiring (browser-6)", () => {
  it("passes priority={isPriority} exactly once (the sm:hidden mobile hero)", () => {
    expect(count(src, "priority={isPriority}")).toBe(1);

    // ...and that one sits inside the sm:hidden banner, not the desktop slot.
    const heroStart = src.indexOf("sm:hidden");
    const thumbStart = src.indexOf("hidden sm:block");
    const heroProp = src.indexOf("priority={isPriority}");
    expect(heroStart).toBeGreaterThan(-1);
    expect(thumbStart).toBeGreaterThan(heroStart);
    expect(heroProp).toBeGreaterThan(heroStart);
    expect(heroProp).toBeLessThan(thumbStart);
  });

  it("keeps the desktop thumbnail lazy: priority={false} once, after the hero", () => {
    expect(count(src, "priority={false}")).toBe(1);
    expect(src.indexOf("priority={false}")).toBeGreaterThan(
      src.indexOf("hidden sm:block"),
    );
  });

  it("raises the desktop thumbnail's fetchPriority for priority cards only", () => {
    expect(count(src, 'fetchPriority={isPriority ? "high" : undefined}')).toBe(1);
    expect(src.indexOf('fetchPriority={isPriority ? "high" : undefined}')).toBeGreaterThan(
      src.indexOf("hidden sm:block"),
    );
  });

  it('keeps the fixed sizes="160px" slot the next-images config test pins', () => {
    expect(src).toContain('sizes="160px"');
  });
});

describe("cluster-card.tsx text contrast (a11y-2)", () => {
  it("has no opacity-modified brand text token", () => {
    expect(src).not.toContain("text-brand/");
  });

  it("styles the '+N başka kaynak' line with the full brand token", () => {
    expect(src).toMatch(/className="text-\[11px\] text-brand"/);
  });
});
