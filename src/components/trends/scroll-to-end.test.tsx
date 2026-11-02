import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isAtStart,
  OVERFLOW_SLACK_PX,
  ScrollHint,
  ScrollToEnd,
  scrollToEndIfOverflowing,
} from "./scroll-to-end";

// browser-5: at 390 px the /trends chart scroller opened at scrollLeft 0, so
// the oldest days showed and the newest bar was off-screen. <ScrollToEnd>
// scrolls its overflow container to the newest day on mount and shows a
// "← önceki günler" hint while older days remain off-screen to the left.

describe("scrollToEndIfOverflowing", () => {
  it("scrolls to the end and returns true when content overflows", () => {
    const el = { scrollWidth: 640, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(640);
  });

  it("returns false and leaves scrollLeft alone when nothing overflows", () => {
    const el = { scrollWidth: 324, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("exports the slack both checks use", () => {
    expect(OVERFLOW_SLACK_PX).toBe(8);
  });

  // h13-edgeux-1: on /trends at 1280x800 the scroller measured scrollWidth 944,
  // clientWidth 942 (spectrum glow / rounding), so the old 1 px slack showed a
  // phantom "← önceki günler" hint although all 30 days were visible.
  it("treats the real /trends desktop case (944 vs 942) as not overflowing and leaves scrollLeft alone", () => {
    const el = { scrollWidth: 944, clientWidth: 942, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("treats a 1px rounding difference as not overflowing", () => {
    const el = { scrollWidth: 325, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("treats an overflow of exactly the slack (8px) as not overflowing", () => {
    const el = { scrollWidth: 324 + OVERFLOW_SLACK_PX, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("treats one pixel more than the slack (9px) as overflowing", () => {
    const el = { scrollWidth: 324 + OVERFLOW_SLACK_PX + 1, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(333);
  });

  it("treats a genuinely wider chart (1100 vs 942) as overflowing and scrolls to the end", () => {
    const el = { scrollWidth: 1100, clientWidth: 942, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(1100);
  });

  it("treats 20px of extra width (660 vs 640) as overflowing even when already scrolled 2px", () => {
    const el = { scrollWidth: 660, clientWidth: 640, scrollLeft: 2 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(660);
  });
});

describe("isAtStart", () => {
  it("is true at scrollLeft 0", () => {
    expect(isAtStart({ scrollLeft: 0 })).toBe(true);
  });

  it("is true within the slack of the start (2px sub-pixel / glow offset)", () => {
    expect(isAtStart({ scrollLeft: 1 })).toBe(true);
    expect(isAtStart({ scrollLeft: 2 })).toBe(true);
  });

  it("uses the same slack as the overflow check: 8 is the start, 9 is not", () => {
    expect(isAtStart({ scrollLeft: OVERFLOW_SLACK_PX })).toBe(true);
    expect(isAtStart({ scrollLeft: OVERFLOW_SLACK_PX + 1 })).toBe(false);
    expect(isAtStart({ scrollLeft: 8 })).toBe(true);
    expect(isAtStart({ scrollLeft: 9 })).toBe(false);
  });

  it("is false once scrolled away from the start", () => {
    expect(isAtStart({ scrollLeft: 316 })).toBe(false);
  });
});

describe("<ScrollToEnd> — server markup", () => {
  const className = "w-full overflow-x-auto spectrum-glow";
  const markup = renderToStaticMarkup(
    <ScrollToEnd className={className} label="Son 30 gün grafiği">
      <svg />
    </ScrollToEnd>,
  );
  const scrollerTag = markup.match(/<div [^>]*role="region"[^>]*>/)?.[0] ?? "";
  const scrollerClass = scrollerTag.match(/class="([^"]*)"/)?.[1] ?? "";

  it("renders the scroller around the child", () => {
    expect(scrollerTag).not.toBe("");
    expect(markup).toContain("<svg></svg>");
  });

  // h17-a11y-1 (WCAG 2.1.1): a scrollable region needs a tab stop, otherwise a
  // keyboard / switch user cannot scroll to the off-screen days.
  it("makes the scroller a focusable, named region", () => {
    expect(scrollerTag).toContain('tabindex="0"');
    expect(scrollerTag).toContain('role="region"');
    expect(scrollerTag).toContain('aria-label="Son 30 gün grafiği"');
  });

  it("keeps the given className and adds a literal focus-visible ring", () => {
    expect(scrollerClass).toContain(className);
    expect(scrollerClass.startsWith(className)).toBe(true);
    expect(scrollerClass).toContain("focus-visible:ring-2");
    expect(scrollerClass).toContain("focus-visible:ring-ring");
    expect(scrollerClass).toContain("focus-visible:outline-none");
  });

  it("puts tabindex, role and name on the same element as the overflow class", () => {
    expect(scrollerClass).toContain("overflow-x-auto");
    expect(scrollerTag).toContain("tabindex");
  });

  it("renders no hint on the server (initial state is not overflowing; SSR must match the first client render)", () => {
    expect(markup).not.toContain("önceki günler");
    expect(markup).not.toContain("kaydırılabilir");
    expect(markup).not.toContain("pointer-events-none");
  });
});

describe("<ScrollHint>", () => {
  const markup = renderToStaticMarkup(<ScrollHint />);

  it("says 'önceki günler'", () => {
    expect(markup).toContain("önceki günler");
  });

  it("hides the arrow from assistive tech", () => {
    expect(markup).toContain('<span aria-hidden="true">← </span>');
  });

  it("gives screen readers the scrollable-chart note", () => {
    expect(markup).toContain(
      '<span class="sr-only"> (grafik yatay kaydırılabilir)</span>',
    );
  });

  it("renders an aria-hidden, non-interactive left fade", () => {
    expect(markup).toMatch(
      /<div aria-hidden="true" class="[^"]*pointer-events-none[^"]*bg-gradient-to-r[^"]*"><\/div>/,
    );
  });

  it("keeps the hint text itself non-interactive", () => {
    expect(markup).toMatch(/<p class="pointer-events-none[^"]*">/);
  });
});

describe("scroll-to-end.tsx — source guard", () => {
  const source = readFileSync(resolve(__dirname, "scroll-to-end.tsx"), "utf8");

  it("is a client component", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("attaches via a stable useCallback ref", () => {
    expect(source).toMatch(/useCallback\(/);
  });

  it("does not use an effect hook (react-hooks/set-state-in-effect)", () => {
    expect(source).not.toMatch(/useEffect|useLayoutEffect/);
  });

  it("renders the hint only while overflowing and not at the start", () => {
    expect(source).toContain("overflowing && !atStart");
  });

  // Tailwind 4 only emits classes it can see as literal tokens; a computed
  // class name would silently drop the focus ring.
  it("spells the focus ring classes out literally", () => {
    expect(source).toContain("focus-visible:outline-none");
    expect(source).toContain("focus-visible:ring-2");
    expect(source).toContain("focus-visible:ring-ring");
    expect(source).toContain("focus-visible:ring-offset-2");
    expect(source).toContain("focus-visible:ring-offset-background");
  });

  it("declares label as a required string prop", () => {
    expect(source).toMatch(/\blabel: string;/);
    expect(source).not.toMatch(/\blabel\?:/);
  });

  it("makes the scroller focusable and a named region", () => {
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain('role="region"');
    expect(source).toContain("aria-label={label}");
  });
});
