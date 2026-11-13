import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkTags } from "../_helpers/jsx-tags";

// ---------------------------------------------------------------------------
// Permanent CI guard (h168): the footer's "Alt menü" links must not
// viewport-prefetch.
//
// The footer is on every page and `next/link` prefetches every link that
// scrolls into the viewport, so a visitor who reaches the bottom of ANY page
// fetched /sources (362 KB decoded RSC) and /metodoloji among the rest: 4 RSC
// requests per page view, for destinations most visitors never open. The links
// stay `next/link` (a plain <a> would make a click re-download the inline
// stylesheet); only the viewport prefetch goes.
//
//     <Link href={link.href} prefetch={false}>     // ok
//     <Link href={link.href}>                      // offender
//
// Scope: src/components/layout/footer.tsx. The header nav is a separate
// decision and is not scanned here.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const FOOTER_FILE = "src/components/layout/footer.tsx";

/** `prefetch={false}`, with optional spaces inside the braces. Linear. */
const PREFETCH_OFF = /\bprefetch=\{\s*false\s*\}/;

/** Every `<Link>` of `src`, with the line it opens on and whether its own tag carries `prefetch={false}`. */
function footerLinks(src: string): { line: number; tag: string; prefetchOff: boolean }[] {
  return linkTags(src).map(({ tag, line }) => ({ line, tag, prefetchOff: PREFETCH_OFF.test(tag) }));
}

const footerSrc = readFileSync(resolve(ROOT, FOOTER_FILE), "utf8");
const links = footerLinks(footerSrc);

describe("the footer does not prefetch its links (h168)", () => {
  it("every <Link> in the footer carries prefetch={false}", () => {
    const offenders = links.filter((l) => !l.prefetchOff).map((l) => `${FOOTER_FILE}:${l.line}`);
    expect(
      offenders,
      `The footer is on every page: a next/link there prefetches /sources (362 KB decoded) and /metodoloji for every visitor who scrolls to the bottom (h168). Add prefetch={false}; keep next/link:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: the footer still renders its NAV_LINKS through next/link", () => {
    expect(footerSrc).toMatch(/^import Link from "next\/link";$/m);
    expect(links.length).toBeGreaterThanOrEqual(1);
    // The one <Link> is the NAV_LINKS map: /sources and /metodoloji are entries of it.
    expect(links.some((l) => l.tag.includes("href={link.href}"))).toBe(true);
    expect(footerSrc).toContain('{ href: "/sources", label: "Kaynaklar" }');
    expect(footerSrc).toContain('{ href: "/metodoloji", label: "Metodoloji" }');
  });

  describe("the guard itself works", () => {
    const flagged = (src: string): number => footerLinks(src).filter((l) => !l.prefetchOff).length;

    it("flags a Link without prefetch", () => {
      expect(flagged("<Link href={link.href} className=\"x\">{link.label}</Link>")).toBe(1);
      expect(flagged('<Link href="/sources">Kaynaklar</Link>')).toBe(1);
    });

    it("passes a Link with prefetch={false}", () => {
      expect(flagged("<Link href={link.href} prefetch={false}>x</Link>")).toBe(0);
      expect(flagged("<Link href={link.href} prefetch={ false }>x</Link>")).toBe(0);
    });

    it("flags a prefetch that is not literally false", () => {
      expect(flagged("<Link href={link.href} prefetch={true}>x</Link>")).toBe(1);
      expect(flagged("<Link href={link.href} prefetch={flag}>x</Link>")).toBe(1);
      expect(flagged("<Link href={link.href} prefetch>x</Link>")).toBe(1);
    });

    it("reads prefetch from its own tag only, not from a neighbouring one", () => {
      const src = [
        "<Link href={a.href}>A</Link>",
        "<Link href={b.href} prefetch={false}>B</Link>",
      ].join("\n");
      expect(footerLinks(src).map(({ line, prefetchOff }) => ({ line, prefetchOff }))).toEqual([
        { line: 1, prefetchOff: false },
        { line: 2, prefetchOff: true },
      ]);
    });

    it("handles a multi-line tag whose prefetch follows an arrow-function attribute", () => {
      const src = `
        <Link
          key={link.href}
          href={link.href}
          onClick={(e) => track(e)}
          prefetch={false}
        >
          {link.label}
        </Link>
      `;
      expect(footerLinks(src).map(({ line, prefetchOff }) => ({ line, prefetchOff }))).toEqual([
        { line: 2, prefetchOff: true },
      ]);
    });

    it("ignores plain anchors", () => {
      expect(flagged('<a href="/rss.xml">RSS</a>')).toBe(0);
    });
  });
});
