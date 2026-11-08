import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h73-breakpoints-2: the header nav stays on one line from 640 to 767 px.
//
// From 640 px the nav labels appear (`sm:`), but the header content box is
// still the 640 px stepped container, so "Kör noktalar" wrapped to two lines
// (a 53 px link in the 56 px header) and so did the "Haber Analizi" subtitle.
// Nowrap alone needs 623 px against 592 available at 640; hiding the subtitle
// until `md` (768 px) brings it to 531 px. Both changes are needed.
//
// Source-text guard, no render of server components. Comments are stripped
// first so prose cannot satisfy (or trip) an assertion.
//
// Kept intact on purpose: the logo divider stays an aria-hidden span with no
// role (h67-landmarks-3, tests/guards/no-role-separator.test.ts).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function read(rel: string): string {
  return stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

const HEADER = read("src/components/layout/header.tsx");
const NAV_LINKS = read("src/components/layout/nav-links.tsx");

const tokens = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

/** className of the span whose text is exactly `text`. */
export function labelSpanClass(src: string, text: string): string | undefined {
  const re = new RegExp(
    `<span\\s+className="([^"]*)"\\s*>\\s*${text}\\s*</span>`,
  );
  return re.exec(src)?.[1];
}

/** Attribute string of the empty logo divider span (the one carrying bg-border/40). */
export function logoDividerAttrs(src: string): string | undefined {
  return /<span\b([^>]*bg-border\/40[^>]*)\/>/.exec(src)?.[1];
}

/** Every className literal in `src` that shows a label from `sm` up. */
export function smInlineClassNames(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((cls) => tokens(cls).includes("sm:inline"));
}

describe("helpers", () => {
  it("labelSpanClass finds the span by its text and ignores other spans", () => {
    const src = `<span className="a">Foo</span><span className="b c">\n  Bar\n</span>`;
    expect(labelSpanClass(src, "Bar")).toBe("b c");
    expect(labelSpanClass(src, "Baz")).toBeUndefined();
  });

  it("smInlineClassNames matches the sm:inline token, not inline-flex or a prefix", () => {
    const src = `<i className="hidden sm:inline"/><i className="sm:inline-flex"/><i className="x"/>`;
    expect(smInlineClassNames(src)).toEqual(["hidden sm:inline"]);
  });

  it("logoDividerAttrs returns the self-closing span carrying bg-border/40", () => {
    const src = `<span aria-hidden="true" className="h-3.5 bg-border/40" />`;
    expect(logoDividerAttrs(src)).toContain('aria-hidden="true"');
    expect(logoDividerAttrs(`<span className="x"/>`)).toBeUndefined();
  });
});

describe("header.tsx: logo subtitle and divider appear from md (768 px)", () => {
  it("the 'Haber Analizi' subtitle is hidden below md and never wraps", () => {
    const cls = labelSpanClass(HEADER, "Haber Analizi");
    expect(cls).toBeDefined();
    const t = tokens(cls!);
    expect(t).toContain("hidden");
    expect(t).toContain("md:inline");
    expect(t).toContain("whitespace-nowrap");
    expect(t).not.toContain("sm:inline");
    expect(cls).toContain("hidden md:inline");
  });

  it("the logo divider shows from md, in step with the subtitle", () => {
    const attrs = logoDividerAttrs(HEADER);
    expect(attrs).toBeDefined();
    const cls = /className="([^"]*)"/.exec(attrs!)?.[1];
    expect(cls).toBeDefined();
    const t = tokens(cls!);
    expect(t).toContain("hidden");
    expect(t).toContain("md:block");
    expect(t).not.toContain("sm:block");
    expect(cls).toContain("hidden md:block");
  });

  it("the logo divider stays aria-hidden decoration with no role (h67-landmarks-3)", () => {
    const attrs = logoDividerAttrs(HEADER);
    expect(attrs).toBeDefined();
    expect(attrs).toContain('aria-hidden="true"');
    expect(attrs).not.toContain("role=");
  });

  it("keeps the stepped 'container mx-auto' wrapper (a full-width wrapper would move the desktop logo)", () => {
    expect(HEADER).toContain(
      'className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6"',
    );
  });
});

describe("nav-links.tsx: visible labels never wrap", () => {
  const LABELS = ["Haberler", "Kör noktalar", "Ekonomi", "Kaydedilenler"];

  it("there are exactly four sm:inline label spans", () => {
    expect(smInlineClassNames(NAV_LINKS)).toHaveLength(4);
  });

  it("every sm:inline label span reads 'hidden sm:inline whitespace-nowrap'", () => {
    for (const cls of smInlineClassNames(NAV_LINKS)) {
      expect(cls).toBe("hidden sm:inline whitespace-nowrap");
    }
  });

  it.each(LABELS)("the visible '%s' label carries whitespace-nowrap", (label) => {
    const classes = [...NAV_LINKS.matchAll(
      new RegExp(`<span\\s+className="([^"]*)">${label}</span>`, "g"),
    )].map((m) => m[1]!);
    const visible = classes.filter((cls) => tokens(cls).includes("sm:inline"));
    expect(visible).toEqual(["hidden sm:inline whitespace-nowrap"]);
  });

  it("keeps the aria-hidden dividers between links (h67-landmarks-3)", () => {
    const dividers = [
      ...NAV_LINKS.matchAll(/<span\s+aria-hidden="true"\s+className="([^"]*)"/g),
    ];
    // Three always-on dividers plus the one before the admin link.
    expect(dividers).toHaveLength(4);
    expect(NAV_LINKS).not.toMatch(/role\s*=\s*["'{`]*\s*separator/);
  });
});
